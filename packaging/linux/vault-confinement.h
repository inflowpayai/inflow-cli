#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <sched.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <unistd.h>

static void check(int result, const char *name) {
  if (result < 0) { fprintf(stderr, "InFlow vault: %s failed (%d)\n", name, result); exit(1); }
}
static void confine_process(void) {
  check(setgroups(0, NULL), "clear supplementary groups");
  for (int cap = 0; cap < 64; cap++) {
    int present = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (present < 0 && errno == EINVAL) break;
    check(present, "inspect bounding set");
    if (cap != CAP_SYS_PTRACE && cap != CAP_SETUID && cap != CAP_SETGID)
      check(prctl(PR_CAPBSET_DROP, cap, 0, 0, 0), "bounding set");
  }
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct data[2] = {{0}};
  data[0].effective = data[0].permitted = (1U << CAP_SYS_PTRACE) | (1U << CAP_SETUID) | (1U << CAP_SETGID);
  check(syscall(SYS_capset, &header, data), "capset");
  check(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no new privileges");
  umask(0077);
  scmp_filter_ctx filter = seccomp_init(SCMP_ACT_ALLOW);
  if (!filter) { fprintf(stderr, "Cannot create vault syscall filter.\n"); exit(1); }
  check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1, SCMP_A0(SCMP_CMP_NE, AF_UNIX)), "socket filter");
  check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socketpair), 1, SCMP_A0(SCMP_CMP_NE, AF_UNIX)), "socketpair filter");
  const int modes[] = {SCMP_SYS(chmod), SCMP_SYS(fchmod), SCMP_SYS(fchmodat), seccomp_syscall_resolve_name("fchmodat2")};
  for (unsigned i = 0; i < sizeof(modes)/sizeof(modes[0]); i++) {
    if (modes[i] == __NR_SCMP_ERROR) exit(1);
    unsigned argument = i < 2 ? 1 : 2;
    check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), modes[i], 1, SCMP_CMP(argument, SCMP_CMP_MASKED_EQ, S_ISUID, S_ISUID)), "setuid mode");
    check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), modes[i], 1, SCMP_CMP(argument, SCMP_CMP_MASKED_EQ, S_ISGID, S_ISGID)), "setgid mode");
  }
  const struct { const char *name; unsigned argument; } creations[] = {
    {"creat", 1}, {"mkdir", 1}, {"mkdirat", 2}, {"mknod", 1}, {"mknodat", 2}
  };
  const unsigned special_modes[] = {S_ISUID, S_ISGID};
  for (unsigned bit = 0; bit < 2; bit++) {
    unsigned mode = special_modes[bit];
    for (unsigned i = 0; i < sizeof(creations)/sizeof(creations[0]); i++) {
      int number = seccomp_syscall_resolve_name(creations[i].name);
      if (number == __NR_SCMP_ERROR) exit(1);
      check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), number, 1,
        SCMP_CMP(creations[i].argument, SCMP_CMP_MASKED_EQ, mode, mode)), "creation mode");
    }
    const unsigned creation_flags[] = {O_CREAT, O_TMPFILE};
    for (unsigned i = 0; i < 2; i++) {
      unsigned flag = creation_flags[i];
      check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(open), 2,
        SCMP_A1(SCMP_CMP_MASKED_EQ, flag, flag), SCMP_A2(SCMP_CMP_MASKED_EQ, mode, mode)), "open mode");
      check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(openat), 2,
        SCMP_A2(SCMP_CMP_MASKED_EQ, flag, flag), SCMP_A3(SCMP_CMP_MASKED_EQ, mode, mode)), "openat mode");
    }
  }
  check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(openat2), 0), "openat2");
  const char *blocked[] = {"unshare", "setns", "mount", "umount2", "pivot_root", "personality", "sched_setscheduler", "sched_setparam", "sched_setattr", "bpf", "perf_event_open", "userfaultfd"};
  for (unsigned i = 0; i < sizeof(blocked)/sizeof(blocked[0]); i++) {
    int number = seccomp_syscall_resolve_name(blocked[i]);
    if (number == __NR_SCMP_ERROR) exit(1);
    check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), number, 0), blocked[i]);
  }
  check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(clone3), 0), "clone3");
  const unsigned flags[] = {CLONE_NEWNS, CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET};
  for (unsigned i = 0; i < sizeof(flags)/sizeof(flags[0]); i++)
    check(seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1, SCMP_A0(SCMP_CMP_MASKED_EQ, flags[i], flags[i])), "clone flags");
  check(seccomp_load(filter), "load filter");
  seccomp_release(filter);
}

#define _GNU_SOURCE
#include "vault-confinement.h"
#include <limits.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <string.h>
#include <sys/file.h>
#include <sys/un.h>

#define VAULT_SOCKET "/run/inflow/vault.sock"
#define VAULT_LOCK "/run/inflow/service.lock"
#define VAULT_EXECUTABLE "/opt/inflow/bin/inflow"

static void fail(const char *message) {
  fprintf(stderr, "InFlow vault: %s\n", message);
  exit(1);
}

static void owned_path(const char *path, uid_t owner, mode_t kind) {
  struct stat st;
  if (lstat(path, &st) < 0 || st.st_uid != owner || (st.st_mode & 0022) ||
      (st.st_mode & S_IFMT) != kind) {
    fprintf(stderr, "InFlow vault: Unsafe service path ownership or permissions: %s\n", path);
    exit(1);
  }
}

static void validate_paths(void) {
  const char *directories[] = {"/run", "/run/inflow", "/var", "/var/lib",
    "/var/lib/inflow-broker", "/opt", "/opt/inflow", "/opt/inflow/bin",
    "/opt/inflow/lib", "/opt/inflow/lib/inflow"};
  for (unsigned i = 0; i < sizeof(directories) / sizeof(directories[0]); i++)
    owned_path(directories[i], 0, S_IFDIR);
  struct passwd *worker = getpwnam("inflow");
  if (!worker || worker->pw_uid == 0 || worker->pw_uid >= 1000)
    fail("The dedicated inflow system account is unavailable.");
  owned_path("/var/lib/inflow", worker->pw_uid, S_IFDIR);
  owned_path(VAULT_EXECUTABLE, 0, S_IFREG);
}

static int open_lock(void) {
  int fd = open(VAULT_LOCK, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  check(fd, "open service lock");
  struct stat st;
  check(fstat(fd, &st), "inspect service lock");
  if (!S_ISREG(st.st_mode) || st.st_uid != 0 || (st.st_mode & 0077) || st.st_nlink != 1)
    fail("Unsafe service lock.");
  return fd;
}

static unsigned long long process_start(pid_t pid) {
  char path[64], line[4096];
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long) pid);
  FILE *file = fopen(path, "re");
  if (!file) return 0;
  char *read = fgets(line, sizeof(line), file);
  fclose(file);
  if (!read) return 0;
  char *field = strrchr(line, ')');
  if (!field || field[1] != ' ') return 0;
  field += 2;
  for (int number = 3; number < 22; number++) {
    field = strchr(field, ' ');
    if (!field) return 0;
    field++;
  }
  return strtoull(field, NULL, 10);
}

static int socket_is_live(void) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  check(fd, "probe socket");
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, VAULT_SOCKET);
  int result = connect(fd, (struct sockaddr *) &address, sizeof(address));
  int cause = errno;
  close(fd);
  if (result == 0 || cause == EAGAIN || cause == EINPROGRESS) return 1;
  if (cause == ENOENT || cause == ECONNREFUSED) return 0;
  fail("Cannot safely inspect the existing service socket.");
  return 0;
}

static void activate(void) {
  /* Standard output carries readiness through Bubblewrap's exec boundary. */
  struct stat pipe;
  check(fstat(STDOUT_FILENO, &pipe), "readiness pipe");
  if (!S_ISFIFO(pipe.st_mode) && !S_ISSOCK(pipe.st_mode)) fail("Missing service-start readiness pipe.");
  int ready = fcntl(STDOUT_FILENO, F_DUPFD, 5);
  check(ready, "preserve readiness pipe");
  int sink = open("/dev/null", O_WRONLY | O_CLOEXEC);
  check(sink, "open output sink");
  check(dup2(sink, STDOUT_FILENO), "redirect broker output");
  close(sink);
  int lock = open_lock();
  if (flock(lock, LOCK_EX | LOCK_NB) < 0) {
    if (errno != EWOULDBLOCK) fail("Cannot lock service startup.");
    for (unsigned attempt = 0; attempt < 500; attempt++) {
      char record[128] = {0};
      ssize_t length = pread(lock, record, sizeof(record) - 1, 0);
      long pid;
      unsigned long long start;
      if (length >= 6 && !strcmp(record + length - 6, "READY\n") &&
          sscanf(record, "%ld %llu", &pid, &start) == 2 && pid > 1 && pid <= INT_MAX &&
          start != 0 && process_start((pid_t) pid) == start) {
        check(write(ready, "READY\n", 6), "notify existing service");
        exit(0);
      }
      usleep(20000);
    }
    fail("The other service startup has not completed; retry shortly.");
  }
  if (socket_is_live()) fail("A service already owns the vault socket without this launcher.");
  struct stat existing;
  if (lstat(VAULT_SOCKET, &existing) == 0) {
    if (!S_ISSOCK(existing.st_mode) || existing.st_uid != 0)
      fail("Refusing to replace an unsafe vault socket.");
    check(unlink(VAULT_SOCKET), "remove stale service socket");
  } else if (errno != ENOENT) fail("Cannot inspect the service socket.");
  int listener = socket(AF_UNIX, SOCK_STREAM, 0);
  check(listener, "create service socket");
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, VAULT_SOCKET);
  check(bind(listener, (struct sockaddr *) &address, sizeof(address)), "bind service socket");
  check(chmod(VAULT_SOCKET, 0666), "service socket permissions");
  check(listen(listener, 128), "listen service socket");
  /* The broker owns the startup lock until exit; the worker does not inherit it. */
  if (lock == 3) {
    int replacement = fcntl(lock, F_DUPFD, 6);
    check(replacement, "preserve service lock");
    close(lock);
    lock = replacement;
  }
  check(fcntl(lock, F_SETFD, 0), "retain service lock");
  if (listener != 3) {
    check(dup2(listener, 3), "activation descriptor");
    close(listener);
  }
  unsigned long long start = process_start(getpid());
  if (!start) fail("Cannot establish service process identity.");
  check(ftruncate(lock, 0), "clear stale service identity");
  if (dprintf(lock, "%ld %llu\n", (long) getpid(), start) < 0) fail("Cannot record service identity.");
  check(fsync(lock), "persist service identity");
  char pid[32], ready_number[32], lock_number[32];
  snprintf(pid, sizeof(pid), "%ld", (long) getpid());
  snprintf(ready_number, sizeof(ready_number), "%d", ready);
  snprintf(lock_number, sizeof(lock_number), "%d", lock);
  check(clearenv(), "clear service environment");
  check(setenv("PATH", "/usr/bin:/bin", 1), "set service path");
  check(setenv("HOME", "/", 1), "set service home");
  check(setenv("LISTEN_PID", pid, 1), "set activation identity");
  check(setenv("LISTEN_FDS", "1", 1), "set activation count");
  check(setenv("LISTEN_FDNAMES", "inflow-vault", 1), "set activation name");
  check(setenv("INFLOW_VAULT_READY_FD", ready_number, 1), "set readiness descriptor");
  check(setenv("INFLOW_VAULT_LOCK_FD", lock_number, 1), "set startup lock descriptor");
  confine_process();
  execl(VAULT_EXECUTABLE, VAULT_EXECUTABLE, "--daemon", "vault-broker", (char *) NULL);
  fail("Cannot execute the packaged vault broker.");
}

static void stop(void) {
  int lock = open_lock();
  if (flock(lock, LOCK_EX | LOCK_NB) == 0) return;
  if (errno != EWOULDBLOCK) fail("Cannot inspect service lock.");
  char record[96] = {0};
  check(pread(lock, record, sizeof(record) - 1, 0), "read service identity");
  long stored_pid;
  unsigned long long stored_start;
  if (sscanf(record, "%ld %llu", &stored_pid, &stored_start) != 2 || stored_pid <= 1 || stored_pid > INT_MAX)
    fail("Service startup is still in progress; retry shortly.");
  pid_t pid = (pid_t) stored_pid;
  int handle = syscall(SYS_pidfd_open, pid, 0);
  if (handle < 0) {
    if (errno == ESRCH) return;
    fail("Cannot securely address the service process.");
  }
  char path[64], executable[PATH_MAX];
  snprintf(path, sizeof(path), "/proc/%ld/exe", stored_pid);
  ssize_t length = readlink(path, executable, sizeof(executable) - 1);
  if (length < 0) fail("Cannot verify the service executable.");
  executable[length] = 0;
  if (process_start(pid) != stored_start || strcmp(executable, VAULT_EXECUTABLE))
    fail("Service identity changed; refusing to terminate another process.");
  check(syscall(SYS_pidfd_send_signal, handle, SIGTERM, NULL, 0), "stop service");
  struct pollfd exited = {.fd = handle, .events = POLLIN};
  if (poll(&exited, 1, 10000) <= 0) fail("Service did not stop within ten seconds.");
  close(handle);
  close(lock);
}

int main(int argc, char **argv) {
  if (getuid() != 0 || geteuid() != 0) fail("Administrator access is required to start or stop the system service.");
  if (argc != 2 || (strcmp(argv[1], "--activate") && strcmp(argv[1], "--stop")))
    fail("Invalid service launcher invocation.");
  umask(0077);
  validate_paths();
  if (!strcmp(argv[1], "--stop")) stop();
  else activate();
  return 0;
}

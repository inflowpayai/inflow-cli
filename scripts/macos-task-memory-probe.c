#include <errno.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc != 2) {
    return 1;
  }

  errno = 0;
  char *end = NULL;
  long parsed_pid = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || parsed_pid <= 0 || parsed_pid > INT32_MAX) {
    return 1;
  }

  mach_port_t task = MACH_PORT_NULL;
  kern_return_t task_result = task_for_pid(mach_task_self(), (pid_t)parsed_pid, &task);
  if (task_result != KERN_SUCCESS) {
    return 0;
  }

  mach_vm_address_t address = 0;
  while (address < MACH_VM_MAX_ADDRESS) {
    mach_vm_size_t size = 0;
    natural_t depth = 0;
    vm_region_submap_info_data_64_t info;
    mach_msg_type_number_t info_count = VM_REGION_SUBMAP_INFO_COUNT_64;
    kern_return_t region_result = mach_vm_region_recurse(
        task, &address, &size, &depth, (vm_region_recurse_info_t)&info, &info_count);
    if (region_result != KERN_SUCCESS) {
      break;
    }
    if ((info.protection & VM_PROT_READ) != 0 && size > 0) {
      uint8_t byte = 0;
      mach_vm_size_t read_size = 0;
      kern_return_t read_result =
          mach_vm_read_overwrite(task, address, sizeof(byte), (mach_vm_address_t)&byte, &read_size);
      if (read_result == KERN_SUCCESS && read_size == sizeof(byte)) {
        mach_port_deallocate(mach_task_self(), task);
        return 2;
      }
    }
    if (size == 0 || address > MACH_VM_MAX_ADDRESS - size) {
      break;
    }
    address += size;
  }

  mach_port_deallocate(mach_task_self(), task);
  return 3;
}

#include <errno.h>
#include <stdio.h>
#include <string.h>

#if defined(__APPLE__)
static int no_replace_rename(const char *source, const char *destination) {
    return renamex_np(source, destination, RENAME_EXCL);
}
#elif defined(__linux__)
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>
static int no_replace_rename(const char *source, const char *destination) {
    return (int) syscall(SYS_renameat2, AT_FDCWD, source, AT_FDCWD, destination, RENAME_NOREPLACE);
}
#else
#error "native-rename-noreplace requires macOS or Linux"
#endif

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: native-rename-noreplace SOURCE DESTINATION\n");
        return 64;
    }
    errno = 0;
    if (no_replace_rename(argv[1], argv[2]) != 0) {
        int saved = errno;
        fprintf(stderr, "%d %s\n", saved, strerror(saved));
        return 1;
    }
    return 0;
}

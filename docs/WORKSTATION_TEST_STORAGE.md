# Workstation test output storage

Current status on2026-10-21: migration and old-copy cleanup are complete.
The authoritative data volume and workspace bind are mounted and readable.
The old `viewer_verify_output.before-migration-20261017/` no longer exists.
Recovery and final cleanup evidence is described at the end of this document;
the earlier blocked states below are historical.

On 2026-10-17 the active worktree's test outputs were copied to
`/mnt/1t/terra-sdk-anti/terra-sdk-miniprogram/viewer_verify_output`.
The existing `viewer_verify_output/` workspace path is a persistent bind mount
of that directory. Existing tests and the local Web service therefore write
to the data disk without changing their output arguments. A plain external
symlink was not used because Docker commands that mount only this workspace
would not have its external target available.

The `/etc/fstab` bind entry depends on `/mnt/1t`. The user service
`terra-sdk-web-local.service` checks the mount before building the site.
Before running tests, verify:

```bash
mountpoint -q viewer_verify_output
findmnt -T viewer_verify_output
df -h viewer_verify_output /
```

The data volume uses NTFS with uid/gid1000 and umask022. File contents and
modification times were copied; original POSIX modes and ownership are retained
in the migration audit, not represented by the destination filesystem.
New tests requiring POSIX-specific filesystem semantics need a suitable scratch
filesystem; their reports and captures should still go to this output directory.

## Verified cutover

- Copied 46,601 regular files, 20,021,703,833 bytes, plus directories.
- A full `rsync -rnc --delete` comparison reported zero content differences.
- The source remained unchanged through verification and service shutdown.
- A Docker container read the migrated Wasm/Chrome files and wrote a probe
  through the original workspace path; the same probe appeared on the data disk.
- The local service restarted on18766. Browser, Worker and Wasm asset hashes
  were unchanged. A bounded Wasm HTTP download matched the expected hash.
- The HTTP client and probe container exited; the manual service remains active.
- No service or application was deployed to server49.

Evidence is under
`viewer_verify_output/workstation_storage_migration_checkpoint_20261017/`.
It includes the original metadata, empty checksum difference log, configuration
backups, cutover script and a checkpoint of uncommitted SDK work.

## Old-copy cleanup before the approved restart

The old directory was renamed to
`viewer_verify_output.before-migration-20261017/` before mounting the destination.
Cleanup began only after the destination, Docker and local service passed their
checks. At09:52, system disk available space had increased from approximately
6.5GiB to22.7GiB. The remainder contained3,558 files /2,998,765,423 bytes.

The cleanup owner (host PID2096372 at that time) was in uninterruptible sleep
inside `unlinkat -> ext4_evict_inode -> folio_wait_bit_common`. Kernel logs also
showed a `kswapd0` exception in `free_buffer_head` at09:29. This is an observed
host kernel problem; the destination verification and service checks passed.
At that checkpoint cleanup had not completed. Final completion is recorded below.

Do not launch a competing deletion while the original owner remains active.
Rebooting the workstation requires the user's explicit approval because it
interrupts other applications. After a restart, verify the mount, destination,
and service, confirm that the original cleanup process is gone, then remove
only this remaining old-copy directory and record the final disk space.
The partial old copy is not a rollback source and must never overwrite the
verified destination.

On2026-10-20 the bind mount and same-device/inode write-through probe were
rechecked before the packed-mirror tests. The system disk had approximately
30GiB free; the data volume had276GiB free. Host PID2096372 remained in stateD,
so no competing deletion was started. The persistent18766 user service was
active with Linger=yes. This confirms the cutover, not completion of the
kernel-blocked old-copy cleanup.

This is a workstation storage/configuration change. SDK compilation gates are
not applicable to the storage documentation. The affected local service was
restarted and verified as described above; subsequent SDK code changes retain
their ordinary build, release, commit and local deployment requirements.

## Data-volume failure on 2026-10-21

At08:11:59 the kernel reported an exception in `free_buffer_head` and recorded
`mount.ntfs-3g[737] exited with irqs disabled`. Both the authoritative data-volume
path and the workspace bind then returned `Transport endpoint is not connected`.
The presence of a mount entry did not prove that the volume was usable.

The final `resident_indices_20261021/` evidence could no longer be read. The
resident-index repair remains uncommitted and undeployed; do not infer final
acceptance from earlier baseline/release passes or the existence of report files.
The18766 service process remained running, but its static files depend on this
volume, so that process state is not proof of a usable Web application.

A read-only process inspection found other projects with working directories
on the disconnected volume, but no open data-volume files. Those processes were
not terminated. A normal unmount of the workspace bind returned busy. The two
dead FUSE connections were subsequently detached without changing `/etc/fstab`
or deleting data. One mount attempt using the original fstab entry then timed
out. Its helper, PID1871751, remained in stateD in
`blkdev_read_iter -> vfs_read -> pread64`; termination was requested, but exit
was not proven. Do not start another concurrent mount or filesystem repair.

At this checkpoint neither `/mnt/1t` nor the workspace bind is mounted. Do not
run output-producing tests, rebuild/restart the manual service, or create output
under the bare workspace directory. The original fstab entries remain the
intended configuration for recovery. The old migration-cleanup process2096372
and its partial old-copy directory were not touched.

The44 pending repair source/test files were copied and verified by SHA-256 on
the source filesystem under
`workspace_old/workstation_recovery_20261021/`. Its `checkpoint.json`,
`pending-repair.patch`, `files/`, and recovery-process record preserve the
uncommitted work and the failed mount attempt independently of the data disk.
This directory is a source/recovery checkpoint, not replacement test storage.

Workstation reboot approval was requested because other applications would be
interrupted; no reboot has been performed. After an owner-approved restart or
administrator recovery, first verify both mounts, readable evidence, and matching
device/inode for the two output paths. Compare the source checkpoint, inspect
the exact frozen-source test receipts, and resume only the missing acceptance
steps. The SDK repair still requires its own commit and verified local deployment.

## Recovery and final cleanup on2026-10-21

The user explicitly authorized workstation reboot. After the restart the boot
ID changed, the original blocked cleanup/mount processes were gone, and a new
NTFS daemon served the original fstab configuration. The authoritative path and
workspace bind both identified device2049/inode57251. The44 pending repair files
matched their pre-reboot SHA-256 checkpoint.

After verifying the destination and excluding nested mounts or symlinks, only
`viewer_verify_output.before-migration-20261017/` was deleted. Its3,558 remaining
files contained2,998,765,423 logical bytes. The directory is absent; observed
system-disk available space increased from30,682,370,048 to33,691,615,232 bytes.
The authoritative source-state marker remained byte-identical, and both output
paths still identified the same directory. The verified destination was not
replaced with the partial old copy.

Host read/write and one `--network none --rm` Docker bind probe passed. The
container was removed. Five bounded static GETs on18766 matched the manual-site
files and frozen pending-repair assets, with `Cache-Control: no-store`; all HTTP
clients closed. No browser or upstream data request was needed. The enabled
manual service remains running after reboot;49 was not deployed to.

The service automatically rebuilds from the active worktree at startup, so it
now serves the pending index repair too. This proves local file availability,
not final SDK release acceptance: the repair is still uncommitted and its real
Tianditu33-stage rerun was interrupted after eight completed stages. The
installed Mini Program package retry did finish and close normally. Inspect
these separate receipts before resuming SDK acceptance.

Evidence: `viewer_verify_output/workstation_storage_cleanup_20261021/` contains
`before.json`, `deletion.json`, `docker-probe.json`, `local-service.json`, and
`completion.json`. Migration is complete. This cleanup/documentation change
does not change deployable SDK code; SDK compilation and a new application
deployment are not applicable. The existing local service was verified as above.

# SDK teardown ownership and failure boundaries

This increment fixes exception paths in the existing Direct/Worker lifecycle.
CBDAM selection, the eight-root imagery tree, screen error targets and joint
presentation/admission rules are unchanged. C ABI43 remains unchanged; Worker
protocol41 adds a fatal control packet that carries no ownership receipt.

## Reproduced defects

The bounded pre-change reproduction in
`viewer_verify_output/abi_teardown_20261019/repro-before.json` uses real SDK
owners and budgets with synthetic native functions, without network traffic:

- A throwing cancellation callback stopped ABI destruction, leaving its native
  context live and10 bytes charged.
- An observer failure during scratch disposal stopped native destruction and
  retained the scratch registration/callback, with74 bytes charged.
- A native over-credit error recursively entered destruction through a scratch
  callback. The resulting error obscured the original mesh error and left the
  scratch registration and callback behind despite deleting the context.

The same reproduction after the fix deletes each context once, removes the
registrations/callbacks, retains the original error and reaches zero charged
bytes after confirmed disposal. These are actual teardown defects; the evidence
does not identify them as the cause of every interaction stall or CDP timeout.

## Disposal contract

`sdk/js/runtime/cleanup` drains independent synchronous cleanup actions and then
throws the first failure. It also preserves a primary operation failure when
subsequent cancellation fails. Cleanup detaches local task/frame references
before invoking callbacks so recursive clear/destroy cannot repeat the same
owner. It does not infer successful physical disposal from an exception.

ABI teardown has explicit phases:

1. Close admission and retire all producer budgets without refunding them.
2. Cancel every registered planner and scratch owner, continuing after failures.
3. Free every independently registered raw ABI allocation.
4. Delete the native context once and invalidate borrowed views.
5. Close producer budgets only when raw buffers and context disposal are both
   confirmed. Report the first cleanup failure after independent owners drain.

`module.alloc/free` allocations are not children of the native terrain context.
Deleting that context alone is insufficient. `TerraAbi` tracks each pointer,
size and packing channel until its free succeeds. Input/output packing counters
therefore change at the ownership boundary, including failures before a caller
receives a newly allocated pointer. Late iterator cleanup cannot free a pointer
already disposed by its ABI. Scratch buffers retain their existing buffer-identity
guard against a stale borrower retiring a successor allocation.

An unexpected allocation/free/delete trap can occur after partial completion.
The ABI is poisoned and borrowed views become invalid; uncertain frees/deletes
are never retried. Producer credit remains retired and charged. A normal capacity
refusal retains its existing status9/recovery behavior.

## Worker termination

After an ABI failure, the host stops accepting work and sends a fatal control
packet instead of reporting zero payload bytes from a zero context. A fatal
packet is not a disposal receipt, even if it contains forged zero-byte fields.
The client terminates the complete Worker and refunds only after the platform's
termination receipt. Browser termination is synchronous; adapters returning a
promise must resolve it only after actual termination.

If termination throws or its promise rejects, pending RPCs and timers are
rejected/cleared but producer credit remains charged. Error reporting callbacks
cannot create an unhandled rejection in this path. Direct Wasm has no equivalent
thread termination receipt: an uncertain native failure closes that ABI and
retains its credit rather than continuing or claiming a successful refund.

Task, mesh-loan, preparation, frame, local execution, runtime and Worker host
cleanup use the same drain-then-report rule. This is not a blanket `finally`
refund for arbitrary payload destructors: an unconfirmed physical disposal must
not release its lease.

## Validation and remaining work

`tests/js/abi_teardown_test.js` checks reentrant cancellation, peer cleanup,
original error identity, raw allocations, failed native receipts, closed
admission, late cleanup, and both successful and failed Worker termination.
`tests/wasm/abi_teardown_contract.js` observes actual Wasm malloc/free and context
deletion, grows memory, and injects a throw after the real delete returns. Its
real Worker test withholds an actual exit receipt and verifies credit remains
charged until that receipt becomes visible. All Worker handles are terminated
in the test's failure/finally path. Source and compressed package run the same
contracts through the release gate.

Evidence lives on the migrated data volume through the existing
`viewer_verify_output/` bind mount. `baseline.log`, `release.log`,
`web/report.json`, `analysis.json`, `deployment.json` and `cleanup.json` record
final gates and local18766 deployment. Server49 receives no deployment.

The final18-step baseline and full SDK release pass with no compiler warnings.
The unchanged native core reuses5ac6fbb's16-core/32-SDK build evidence; this
increment rebuilds SDK/Wasm and repeats the32 SDK tests and downstream gates.
Both source and compressed package pass the new JS and real Wasm/Worker
contracts. The Intel Vulkan browser report contains348 passing checks. All nine
execution/network/scene combinations reach the original terrain/imagery targets,
with zero sampled blanks/missing tiles and zero owned resources/requests/timers
after destruction. The Wasm hash is unchanged. Oblique settlement remains about
9.8–12.5 seconds; these results do not establish a latency improvement.

The complete measurement/input boundary, other derived metadata ownership,
constrained joint terrain/UV/imagery publication, the20s CDP/page stall, actual
device frame/input latency, walking/slope and external API/device acceptance
remain open under P0–P4. This lifecycle repair is not industrial acceptance.

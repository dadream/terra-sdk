// Reserve the producer's payload and its destination together. A ready input
// cannot consume the space needed to submit its output. Claimed output leases
// stay owned by the destination until its completion/failure receipt.
class OutputTransaction {
  static reserve(ledger, inputBytes, outputBytes, inputOwner, outputOwner, keep = []) {
    ledger.size(inputBytes); ledger.size(outputBytes)
    const input = ledger.reserve(inputOwner, inputBytes + outputBytes, [], keep)
    if (!input) return null
    return new OutputTransaction(input, input.split(outputBytes, 'reserved', outputOwner))
  }

  constructor(input, output) { this.input = input; this.output = output; this.closed = false }
  takeOutput(bytes) {
    if (this.closed) throw new Error('Output transaction is closed')
    return this.output.split(bytes, 'reserved')
  }
  returnOutput(lease) {
    if (this.closed) lease.release()
    else this.output.merge(lease)
  }
  retire() {
    this.input.mark('retired'); this.output.mark('retired')
  }
  release() {
    this.closed = true
    this.input.release(); this.output.release()
  }
}

module.exports = {OutputTransaction}

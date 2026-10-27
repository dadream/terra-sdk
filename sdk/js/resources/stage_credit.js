// Sequential producers share one reserved peak. Returning a stage's credit
// cannot refund a live operation or resurrect a cancelled outer transaction.
async function runCreditStage(credit, owner, bytes, run) {
  const stage = credit.split(bytes, 'reserved', owner)
  try { return await run(stage) }
  finally {
    if (credit.active && stage.bytes) {
      credit.merge(stage.split(stage.bytes, 'reserved', credit.owner))
    }
    stage.release()
  }
}

module.exports = {runCreditStage}

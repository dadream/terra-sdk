// Small financial fixtures describe buffers, not a native camera/display cut.
// Keep their byte-exact CPU/GPU/UV assertions separate from the real complete
// frame contracts, which must also fund numerical display topology and work.
module.exports = function allocationQuote(plan) {
  const admit=plan.admit.bind(plan)
  plan.admit=(packet,bytes,stage)=>{
    const allocation=Object.assign({},packet)
    delete allocation.frame
    return admit(allocation,bytes,stage)
  }
  return plan
}

// Scheduling fixtures supply a completed/failing native round. The real ABI
// tests cover bounded input packing, Wasm growth and cancellation of scratch.
module.exports = {
  createImageryTask(...args) {
    return {step: async () => ({done: true, value: await this.planImageryAsync(...args)}), cancel() {}}
  }
}

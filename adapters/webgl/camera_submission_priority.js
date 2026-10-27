// An actual display attempt can lose to a resource fence. Once the GPU queue
// drains, offer that camera one bounded window before starting another upload.
// Pointer updates do not renew it. A withheld display clock therefore cannot
// stop background work; only another blocked display attempt can ask again.
class CameraSubmissionPriority {
  constructor(){this.clear()}
  request(){if(!this.requested){this.requested=true;this.deadline=undefined}}
  delay(now) {
    if(!this.requested)return 0
    // Two nominal display intervals also tolerate phase differences between
    // the resource poll and the host's next animation callback.
    if(this.deadline===undefined)this.deadline=now+32
    const remaining=this.deadline-now
    if(remaining>0)return remaining
    this.clear();return 0
  }
  clear(){this.requested=false;this.deadline=undefined}
}

module.exports={CameraSubmissionPriority}

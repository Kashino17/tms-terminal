function reconcilePredictions(queue, rttEstimateMs, nowMs) {
  var confirmed = [];
  var pending = [];
  var watermark = nowMs - rttEstimateMs;
  for (var i = 0; i < queue.length; i++) {
    var entry = queue[i];
    if (entry.sentAt <= watermark) {
      confirmed.push(entry);
    } else {
      pending.push(entry);
    }
  }
  return { confirmed: confirmed, pending: pending };
}

module.exports = { reconcilePredictions: reconcilePredictions };

/* Optional imitation DSP. No microphone, network calls, persistence, or model. */
'use strict';
importScripts('imitation-features.js');
self.onmessage = function (event) {
  var request = event.data, pcm = null, result;
  if (!request || request.type !== 'analyze') return;
  try {
    if (!(request.buffer instanceof ArrayBuffer) || !Number.isFinite(request.rate) ||
        request.rate < 16000 || request.rate > 192000 ||
        request.buffer.byteLength > Math.floor(request.rate * 6) * 4 ||
        request.buffer.byteLength % 4) throw new Error('invalid_input');
    pcm = new Float32Array(request.buffer);
    result = GBRhythmFeatures.analyze(pcm, request.rate);
  } catch (error) {
    result = {ok:false, why:'invalid_input'};
  } finally {
    // Discard raw samples before returning only the small derived phrase.
    if (pcm) pcm.fill(0);
    pcm = null;
    if (request) request.buffer = null;
  }
  self.postMessage({type:'result', id:request.id, epoch:request.epoch, result:result});
};

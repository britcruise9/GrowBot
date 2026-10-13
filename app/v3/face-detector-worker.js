/* Classic worker: MediaPipe's WASM loader may use importScripts. Only model assets are
 * fetched; the transferred camera bitmap is never uploaded. No body/relay access. */
var model=null,loading=false,flow=null,flowCanvas=null,flowContext=null,flowToken=null,lastDetect=-Infinity;
function grayFrame(bitmap){
  var scale=Math.min(160/bitmap.width,120/bitmap.height);
  var w=Math.max(16,Math.round(bitmap.width*scale)),h=Math.max(16,Math.round(bitmap.height*scale));
  if(!flowCanvas){flowCanvas=new OffscreenCanvas(w,h);flowContext=flowCanvas.getContext('2d',{willReadFrequently:true});}
  if(flowCanvas.width!==w||flowCanvas.height!==h){flowCanvas.width=w;flowCanvas.height=h;flow.reset();}
  flowContext.drawImage(bitmap,0,0,w,h);
  var rgba=flowContext.getImageData(0,0,w,h).data,gray=new Float32Array(w*h);
  for(var i=0;i<gray.length;i++)gray[i]=(rgba[4*i]*77+rgba[4*i+1]*150+rgba[4*i+2]*29)/256;
  return {gray:gray,w:w,h:h};
}
self.onmessage=function(ev){
  var d=ev.data||{};
  if(d.type==='init'&&!model&&!loading){
    loading=true;
    Promise.resolve().then(function(){
      if(d.flow)return import('/v3/face-optical-flow.mjs').then(function(f){flow=new f.FaceFlow();});
    }).then(function(){return import('/v3/agent-face-track.mjs');})
      .then(function(m){return m.faceDetector(new OffscreenCanvas(1,1));})
      .then(function(loaded){
        model=loaded;
        /* Compile the GPU graph before announcing readiness. The first real frame must not
         * pay shader warm-up or be misclassified as a hung inference. No camera is used. */
        var warm=new OffscreenCanvas(320,240);warm.getContext('2d').fillRect(0,0,320,240);
        model.detectForVideo(warm,0);
        self.postMessage({type:'ready'});
      })
      .catch(function(){self.postMessage({type:'error'});});
    return;
  }
  if(d.type!=='frame')return;
  var bitmap=d.bitmap;
  try{
    if(!model||!bitmap)throw Error('not_ready');
    var w=bitmap.width,h=bitmap.height,t0=performance.now(),g=null,tracked=null;
    var allowFlow=flow&&d.context&&d.context.allowFlow===true;
    if(flow){
      if(!allowFlow||flowToken!==d.context.token)flow.reset();
      flowToken=d.context?d.context.token:null;
      if(allowFlow){
        g=grayFrame(bitmap);
        /* Detector remains at least 15/s while following. Failed flow triggers inference now.
         * Startup, loss, multiple faces and authority changes always use actual detections. */
        if(d.at-lastDetect<1000/15-4)tracked=flow.step(g.gray,g.w,g.h,d.at);
      }
    }
    if(tracked){
      self.postMessage({type:'result',id:d.id,boxes:[tracked.box],source:'flow',anchorAt:tracked.anchorAt,flowMs:performance.now()-t0});
      return;
    }
    var detectStart=performance.now(),result=model.detectForVideo(bitmap,d.at),ms=performance.now()-detectStart;
    lastDetect=d.at;
    var boxes=(result&&result.detections||[]).map(function(v){var b=v.boundingBox;
      return {x:b.originX/w,y:b.originY/h,width:b.width/w,height:b.height/h};});
    if(allowFlow&&g)flow.seed(g.gray,g.w,g.h,boxes,d.at);
    self.postMessage({type:'result',id:d.id,boxes:boxes,source:'detector',detectMs:ms});
  }catch(err){self.postMessage({type:'error',id:d.id});}
  finally{if(bitmap)bitmap.close();}
};

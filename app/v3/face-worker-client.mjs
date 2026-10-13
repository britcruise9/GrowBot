/* Optional local detector worker. One capture/inference in flight, no image queue.
 * Images stay inside this browser. Closing/timeout terminates the worker and invalidates
 * every promise/callback. The host still owns camera, authorization and motor control.
 */
export function createFaceWorker(env, options) {
  var e=env||window; options=options||{};
  if(!e.Worker||!e.OffscreenCanvas||!e.createImageBitmap)
    return Promise.reject(new Error('worker_unavailable'));
  return new Promise(function(resolve,reject){
    var worker,closed=false,ready=false,pending=null,serial=0,timer=null;
    var later=e.setTimeout.bind(e),cancel=e.clearTimeout.bind(e);
    var client={busy:false,workerMode:true,flowMode:options.flow===true};
    function clearTimer(){ if(timer!==null){ cancel(timer); timer=null; } }
    function close(){
      if(closed)return;
      closed=true; clearTimer(); client.busy=false; pending=null;
      if(worker)worker.terminate();
    }
    function fail(reason){
      if(closed)return;
      var job=pending; close();
      if(!ready)reject(new Error(reason));
      else if(job)job.error(new Error(reason));
      else if(client.onIdleError)client.onIdleError(new Error(reason));
    }
    client.close=close;
    client.detectAsync=function(video,at,done,error,context){
      if(closed||!ready||client.busy)return false;
      client.busy=true; var id=++serial;
      pending={id:id,done:done,error:error};
      /* Bounded below the controller's 400 ms observation expiry. A hung bitmap conversion
       * is subject to the same deadline as inference; its eventual bitmap is closed. */
      timer=later(function(){fail('worker_frame_timeout');},350);
      Promise.resolve().then(function(){return e.createImageBitmap(video);}).then(function(bitmap){
        if(closed||!pending||pending.id!==id){bitmap.close();return;}
        try{worker.postMessage({type:'frame',id:id,at:at,bitmap:bitmap,context:context||null},[bitmap]);}
        catch(err){bitmap.close();fail('worker_transfer_failed');}
      }).catch(function(){fail('worker_capture_failed');});
      return true;
    };
    try{worker=new e.Worker('/v3/face-detector-worker.js');}
    catch(err){reject(err);return;}
    worker.onmessage=function(ev){
      if(closed)return;
      var d=ev.data||{};
      if(d.type==='ready'&&!ready){ready=true;clearTimer();resolve(client);return;}
      if(d.type==='error'){fail('worker_detector_failed');return;}
      if(d.type!=='result'||!pending||d.id!==pending.id)return;
      var job=pending;pending=null;client.busy=false;clearTimer();job.done(d);
    };
    worker.onerror=function(ev){if(ev&&ev.preventDefault)ev.preventDefault();fail('worker_error');};
    timer=later(function(){fail('worker_load_timeout');},10000);
    try{worker.postMessage({type:'init',flow:client.flowMode});}catch(err){fail('worker_init_failed');}
  });
}

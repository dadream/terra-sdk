// Offline experiment: conservative triangle outlines using immutable source
// vertices. This owns duplicate query textures only for the bounded replay;
// production needs an admitted/shared geometry representation and depth owner.
window.probeTriangleVisibility = async function ({gl, draw, fence, input, depth}) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 2) throw Error('Triangle replay depth must be 0..2')
  const draws=input.sourceDraws||input.draws, source=new Map(draws.map(d=>[d.resourceId,d]))
  if(source.size!==draws.length)throw Error('Triangle replay requires unique mesh instances')
  const textures=[],shaders=[],live=new Set(),previous=gl.getParameter(gl.CURRENT_PROGRAM)
  const activeTexture=gl.getParameter(gl.ACTIVE_TEXTURE),started=performance.now()
  let program,bytes=0,count=0,maximumLive=0,vertices=0
  const decode=(text,Type)=>new Type(Uint8Array.from(atob(text),c=>c.charCodeAt(0)).buffer)
  try {
    gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.colorMask(false,false,false,false)
    gl.clear(gl.DEPTH_BUFFER_BIT);draw({id:1,draws});await fence();gl.depthMask(false)
    const texture=(data,components,format,external,type,unit)=>{
      const width=64,height=Math.ceil(data.length/components/width)
      const padded=new data.constructor(width*height*components);padded.set(data)
      const object=gl.createTexture();textures.push(object);bytes+=padded.byteLength
      gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,object)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D,0,format,width,height,0,external,type,padded)
      return object
    }
    const index=texture(decode(input.snapshot.indices,Uint16Array),1,gl.R16UI,gl.RED_INTEGER,gl.UNSIGNED_SHORT,0)
    const meshes=new Map(input.snapshot.meshes.map(mesh=>[mesh.id,{
      positions:texture(decode(mesh.positions,Float32Array),3,gl.RGB32F,gl.RGB,gl.FLOAT,1),
      uv:texture(decode(mesh.uv,Float32Array),2,gl.RG32F,gl.RG,gl.FLOAT,2)}]))
    program=gl.createProgram()
    const vertex=`#version 300 es
      precision highp float;precision highp int;
      uniform highp usampler2D indices;uniform highp sampler2D positions;uniform highp sampler2D uv;
      uniform mat4 matrix;uniform vec3 origin;uniform int first;
      uniform vec3 cell;uniform vec2 pixel;
      ivec2 address(int i){return ivec2(i%64,i/64);}
      vec2 crossPoint(vec2 a,vec2 b,float da,float db){float d=a.x*b.y-a.y*b.x;
        return vec2(da*b.y-a.y*db,a.x*db-da*b.x)/d;}
      float cross2(vec2 a,vec2 b){return a.x*b.y-a.y*b.x;}
      void absent(){gl_Position=vec4(2.0,2.0,2.0,1.0);}
      void rectangle(vec2 lo,vec2 hi,float z,int v){
        vec2 p=v==0?lo:v==1?vec2(hi.x,lo.y):v==2||v==3?vec2(lo.x,hi.y):v==4?vec2(hi.x,lo.y):hi;
        gl_Position=vec4(p,z,1.0);
      }
      void main(){
        int f=gl_VertexID/6,v=gl_VertexID%6;
        ivec3 ids=ivec3(texelFetch(indices,address(first+f),0).r,
          texelFetch(indices,address(first+f+1),0).r,texelFetch(indices,address(first+f+2),0).r);
        if(ids.x==ids.y||ids.y==ids.z||ids.z==ids.x){absent();return;}
        if((f&1)==1)ids=ids.yxz;
        vec2 ta=texelFetch(uv,address(ids.x),0).rg,tb=texelFetch(uv,address(ids.y),0).rg,tc=texelFetch(uv,address(ids.z),0).rg;
        vec2 lower=-cell.yz/cell.x,upper=(vec2(1.0)-cell.yz)/cell.x;
        float uvError=64.0*exp2(-23.0)*max(1.0,max(max(max(abs(ta.x),abs(ta.y)),max(abs(tb.x),abs(tb.y))),max(abs(tc.x),abs(tc.y))));
        if(any(lessThan(max(ta,max(tb,tc))+uvError,lower))||any(greaterThan(min(ta,min(tb,tc))-uvError,upper))){absent();return;}
        vec3 pa=texelFetch(positions,address(ids.x),0).rgb,pb=texelFetch(positions,address(ids.y),0).rgb,pc=texelFetch(positions,address(ids.z),0).rgb;
        vec3 magnitude=max(abs(pa+origin),max(abs(pb+origin),abs(pc+origin)));
        vec3 storage=max(abs(pa),max(abs(pb),abs(pc)))*4.0*exp2(-23.0);
        vec4 error=vec4(0.0);
        for(int i=0;i<4;++i){
          vec3 row=abs(vec3(matrix[0][i],matrix[1][i],matrix[2][i]));
          error[i]=(abs(matrix[3][i])+1.0+dot(row,magnitude))*16.0*exp2(-23.0)+dot(row,storage);
        }
        vec4 a=matrix*vec4(pa+origin,1.0),b=matrix*vec4(pb+origin,1.0),c=matrix*vec4(pc+origin,1.0);
        // Only prove a full-frustum rejection. Near/eye intersections cannot
        // authorize removal; emit a full-screen nearest rectangle instead.
        for(int axis=0;axis<3;++axis)for(int sign=-1;sign<=1;sign+=2){
          float e=error[axis]+error.w;
          if(float(sign)*a[axis]+a.w < -e && float(sign)*b[axis]+b.w < -e && float(sign)*c[axis]+c.w < -e){absent();return;}
        }
        if(min(a.w,min(b.w,c.w))<=error.w || min(a.z+a.w,min(b.z+b.w,c.z+c.w))<=error.z+error.w){rectangle(vec2(-1.0),vec2(1.0),-1.0,v);return;}
        vec2 p[3];p[0]=a.xy/a.w;p[1]=b.xy/b.w;p[2]=c.xy/c.w;
        vec4 clips[3];clips[0]=a;clips[1]=b;clips[2]=c;
        vec2 epsilon=vec2(0.0);float nearDepth=1.0;
        for(int i=0;i<3;++i){vec4 q=clips[i];
          vec2 lo=min((q.xy-error.xy)/(q.w-error.w),(q.xy-error.xy)/(q.w+error.w));
          vec2 hi=max((q.xy+error.xy)/(q.w-error.w),(q.xy+error.xy)/(q.w+error.w));
          epsilon=max(epsilon,max(p[i]-lo,hi-p[i]));
          nearDepth=min(nearDepth,min((q.z-error.z)/(q.w-error.w),(q.z-error.z)/(q.w+error.w)));
        }
        // Bound orientation uncertainty before rejecting a clockwise-culling
        // backface. Pixel dilation affects coverage, not this predicate.
        vec2 ab=p[1]-p[0],ac=p[2]-p[0];float area=cross2(ab,ac);
        float areaError=2.0*(abs(ab.x)*epsilon.y+abs(ab.y)*epsilon.x+abs(ac.x)*epsilon.y+abs(ac.y)*epsilon.x)+8.0*epsilon.x*epsilon.y;
        if(area>areaError+1e-6*(abs(ab.x*ac.y)+abs(ab.y*ac.x))){absent();return;}
        epsilon+=pixel;
        vec2 lo=min(p[0],min(p[1],p[2]))-epsilon,hi=max(p[0],max(p[1],p[2]))+epsilon;
        nearDepth=max(-1.0,nearDepth-1e-5);
        if(abs(area)<=areaError+1e-12){rectangle(lo,hi,nearDepth,v);return;}
        vec2 n[3];float d[3];
        for(int i=0;i<3;++i){vec2 edge=p[(i+1)%3]-p[i];n[i]=sign(area)*normalize(vec2(edge.y,-edge.x));d[i]=dot(abs(n[i]),epsilon);}
        vec2 expanded[3];bool wide=false;
        for(int i=0;i<3;++i){int j=(i+2)%3;
          if(abs(cross2(n[i],n[j]))<1e-5){wide=true;expanded[i]=p[i];}
          else {expanded[i]=p[i]+crossPoint(n[i],n[j],d[i],d[j]);
            if(any(greaterThan(abs(expanded[i]-p[i]),vec2(2.0))))wide=true;}
        }
        if(wide){rectangle(lo,hi,nearDepth,v);return;}
        // A six-vertex invocation also supports the rectangle fallback. The
        // second triangle is degenerate when the expanded triangle suffices.
        gl_Position=vec4(expanded[v<3?v:0],nearDepth,1.0);
      }`
    for(const [type,code] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,`#version 300 es
      precision highp float;out vec4 color;void main(){color=vec4(0.0);}`]]){
      const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,code);gl.compileShader(shader)
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader))
      gl.attachShader(program,shader)
    }
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program))
    gl.useProgram(program);gl.disable(gl.CULL_FACE)
    const u=Object.fromEntries(['indices','positions','uv','matrix','origin','first','cell','pixel'].map(n=>[n,gl.getUniformLocation(program,n)]))
    gl.uniform1i(u.indices,0);gl.uniform1i(u.positions,1);gl.uniform1i(u.uv,2)
    gl.uniformMatrix4fv(u.matrix,false,input.matrix);gl.uniform2f(u.pixel,2/gl.drawingBufferWidth,2/gl.drawingBufferHeight)
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,index)
    let frontier=draws.map(d=>({id:d.resourceId,scale:d.imageryClipCell?d.imageryCellScale:1,
      x:d.imageryClipCell?-d.imageryCellOffsetX:0,y:d.imageryClipCell?-d.imageryCellOffsetY:0}))
    const levels=[]
    for(let level=0;level<=depth;++level){
      const visible=[]
      for(let first=0;first<frontier.length;first+=64){
        if(performance.now()-started>60000 || count+Math.min(64,frontier.length-first)>8192)throw Error('Triangle replay work limit exceeded')
        const batch=frontier.slice(first,first+64)
        for(const cell of batch){
          const d=source.get(cell.id),mesh=meshes.get(cell.id),q=gl.createQuery()
          if(!q)throw Error('Triangle query allocation failed')
          live.add(q);cell.query=q;++count
          gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,mesh.positions)
          gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,mesh.uv)
          gl.uniform3f(u.origin,...d.origin.map((v,i)=>v-input.camera[i]));gl.uniform1i(u.first,d.firstIndex)
          gl.uniform3f(u.cell,cell.scale,-cell.x,-cell.y)
          gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,q)
          try{const n=Math.max(0,d.indexCount-2)*6;vertices+=n;gl.drawArrays(gl.TRIANGLES,0,n)}
          finally{gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE)}
        }
        maximumLive=Math.max(maximumLive,live.size);await fence()
        for(const cell of batch){
          if(!gl.getQueryParameter(cell.query,gl.QUERY_RESULT_AVAILABLE))throw Error('Triangle query receipt unavailable')
          if(gl.getQueryParameter(cell.query,gl.QUERY_RESULT))visible.push({id:cell.id,scale:cell.scale,x:cell.x,y:cell.y})
          gl.deleteQuery(cell.query);live.delete(cell.query)
        }
      }
      levels.push({depth:level,queried:frontier.length,visible})
      frontier=visible.flatMap(c=>[0,1,2,3].map(i=>({id:c.id,scale:c.scale*2,x:c.x*2+i%2,y:c.y*2+Math.floor(i/2)})))
    }
    return {schema:'terra.offline-visible-uv.v1',levels,queries:count,maximumLive,queryVertices:vertices,
      queryGeometryBytes:bytes,queryGeometryTextures:textures.length,durationMs:performance.now()-started,
      conservativeTriangles:true,scope:'Fixed-view expanded triangle experiment; duplicate GPU query inputs; not a production culling certificate, capacity admission or runtime-performance claim.'}
  }finally{
    live.forEach(q=>gl.deleteQuery(q));textures.forEach(t=>gl.deleteTexture(t))
    if(program)gl.deleteProgram(program);shaders.forEach(s=>gl.deleteShader(s))
    gl.depthMask(true);gl.colorMask(true,true,true,true);gl.enable(gl.CULL_FACE);gl.useProgram(previous);gl.activeTexture(activeTexture)
  }
}

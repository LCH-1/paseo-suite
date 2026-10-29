import { spawn } from "node:child_process";
import { MAX_BYTES } from "../shared/model";

const script = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{input+=part;if(input.length>65536)process.exit(1)});process.stdin.on('end',async()=>{try{const data=JSON.parse(input);input='';const url=new URL(data.url);if(url.protocol!=='https:'||!['api.github.com','gist.githubusercontent.com'].includes(url.hostname)||url.username||url.password)throw Error();const response=await fetch(url,{method:'GET',headers:data.headers,redirect:'error',signal:AbortSignal.timeout(25000)});const text=await response.text();if(Buffer.byteLength(text)>${MAX_BYTES * 2})throw Error();process.stdout.write(JSON.stringify({status:response.status,text}));}catch{process.exitCode=1}});`;

export function freshGitHubGet(url: string | URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "pipe" });
    const chunks: Buffer[] = [];
    let bytes = 0, done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (ok) {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599 || typeof value.text !== "string") throw Error();
          resolve(new Response(value.text, { status: value.status }));
          return;
        } catch {}
      }
      child.kill(); reject(new Error("GitHub 읽기 연결을 새로 확인하지 못했습니다."));
    };
    const timer = setTimeout(() => finish(false), 27_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BYTES * 4) finish(false); else chunks.push(chunk); });
    child.stderr.resume(); child.on("error", () => finish(false)); child.stdin.on("error", () => finish(false)); child.on("close", (code) => finish(code === 0));
    child.stdin.end(JSON.stringify({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) }));
  });
}

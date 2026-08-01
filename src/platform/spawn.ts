import { spawn } from "node:child_process";
import { basename } from "node:path";

export async function run(command: string, arguments_: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${basename(command)} exited with ${
            signal === null ? `code ${code}` : `signal ${signal}`
          }`,
        ),
      );
    });
  });
}

export async function runOutput(command: string, arguments_: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      reject(
        new Error(
          `${basename(command)} exited with ${
            signal === null ? `code ${code}` : `signal ${signal}`
          }\n${output.trim()}`,
        ),
      );
    });
  });
}

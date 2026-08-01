import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface R2Credentials {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function r2CredentialsFromEnvironment(prefix: string): R2Credentials {
  const endpoint = process.env.TENNA_R2_ENDPOINT;
  const accessKeyId = process.env[`${prefix}_ACCESS_KEY_ID`];
  const secretAccessKey = process.env[`${prefix}_SECRET_ACCESS_KEY`];
  if (endpoint === undefined || endpoint === "") throw new Error("Missing TENNA_R2_ENDPOINT");

  if (accessKeyId === undefined || accessKeyId === "") {
    throw new Error(`Missing ${prefix}_ACCESS_KEY_ID`);
  }

  if (secretAccessKey === undefined || secretAccessKey === "") {
    throw new Error(`Missing ${prefix}_SECRET_ACCESS_KEY`);
  }

  return { endpoint, accessKeyId, secretAccessKey };
}

export class R2ObjectStore {
  client: Bun.S3Client;

  constructor(bucket: string, credentials: R2Credentials) {
    this.client = new Bun.S3Client({ bucket, ...credentials });
  }

  exists(key: string): Promise<boolean> {
    return this.client.exists(key);
  }

  readText(key: string): Promise<string> {
    return this.client.file(key).text();
  }

  async download(key: string, destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const staging = `${destination}.download`;
    await rm(staging, { force: true });

    try {
      await Bun.write(staging, this.client.file(key));
      await rename(staging, destination);
    } finally {
      await rm(staging, { force: true });
    }
  }

  async upload(key: string, source: string, contentType: string): Promise<void> {
    await this.client.file(key).write(Bun.file(source), { type: contentType });
  }
}

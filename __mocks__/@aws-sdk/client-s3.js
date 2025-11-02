export class S3Client {
  constructor() {}
  send() {
    return Promise.resolve({});
  }
}

export class PutObjectCommand {
  constructor(params) {
    this.params = params;
  }
}

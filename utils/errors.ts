import { GraaspErrorDetails, GraaspError } from 'graasp';

export class GraaspS3FileItemError implements GraaspError {
  name: string;
  code: string
  message: string;
  statusCode?: number;
  data?: unknown;
  origin: 'plugin' | string;

  constructor({ code, statusCode, message }: GraaspErrorDetails, data?: unknown) {
    this.name = code;
    this.code = code;
    this.message = message;
    this.statusCode = statusCode;
    this.data = data;
    this.origin = 'graasp-s3-file-item';
  }
}

export class NotS3FileItem extends GraaspS3FileItemError {
  constructor(data?: unknown) {
    super({ code: 'GS3FIERR001', statusCode: 400, message: 'Item is not a "s3-file-item"' }, data);
  }
}

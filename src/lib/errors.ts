export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function badRequest(msg: string): HttpError {
  return new HttpError(400, msg);
}
export function unauthorized(msg = '未登录或会话已过期'): HttpError {
  return new HttpError(401, msg);
}
export function forbidden(msg = '没有权限'): HttpError {
  return new HttpError(403, msg);
}
export function notFound(msg = '资源不存在'): HttpError {
  return new HttpError(404, msg);
}
export function conflict(msg: string): HttpError {
  return new HttpError(409, msg);
}

/*!
 * qn - lib/client.js
 * Copyright(c) 2013 fengmk2 <fengmk2@gmail.com>  (http://fengmk2.github.com)
 * MIT Licensed
 */

"use strict";

/**
 * Module dependencies.
 */

var urllib = require('urllib');
var utility = require('utility');
var FormStream = require('formstream');

function Qiniu(options) {
  if (!options || !options.accessKey || !options.secretKey || !options.bucket) {
    throw new TypeError('required accessKey, secretKey and bucket');
  }

  options.domain = options.domain || null;
  options.timeout = options.timeout || 36000000;
  this.options = options;
  this._uploadURL = 'http://up.qiniu.com/';
}

Qiniu.create = function create(options) {
  return new Qiniu(options);
};

/**
 * Create uploadToken
 * @see http://docs.qiniu.com/api/v6/put.html#uploadToken
 * 
 * @param {Object} options
 *  - {String} scope 一般指文件要上传到的目标存储空间（Bucket）。
 *                   若为”Bucket”，表示限定只能传到该Bucket（仅限于新增文件）；若为”Bucket:Key”，表示限定特定的文件，可修改该文件。
 *  - {Number} [deadline] 定义 uploadToken 的失效时间，Unix时间戳，精确到秒，缺省为 3600 秒
 *  - {String} [endUser] 给上传的文件添加唯一属主标识，特殊场景下非常有用，比如根据终端用户标识给图片或视频打水印
 *  - {String} [returnUrl] 设置用于浏览器端文件上传成功后，浏览器执行301跳转的URL，一般为 HTML Form 上传时使用。
 *                         文件上传成功后会跳转到 returnUrl?query_string, query_string 会包含 returnBody 内容。
 *                         returnUrl 不可与 callbackUrl 同时使用。 
 *  - {String} [returnBody] 文件上传成功后，自定义从 Qiniu-Cloud-Server 最终返回給终端 App-Client 的数据。
 *                          支持 魔法变量，不可与 callbackBody 同时使用。
 *  - {String} [callbackBody] 文件上传成功后，Qiniu-Cloud-Server 向 App-Server 发送POST请求的数据。
 *                            支持 魔法变量 和 自定义变量，不可与 returnBody 同时使用。
 *  - {String} [callbackUrl] 文件上传成功后，Qiniu-Cloud-Server 向 App-Server 发送POST请求的URL，
 *                           必须是公网上可以正常进行POST请求并能响应 HTTP Status 200 OK 的有效 URL
 *  - {String} [asyncOps] 指定文件（图片/音频/视频）上传成功后异步地执行指定的预转操作。
 *                        每个预转指令是一个API规格字符串，多个预转指令可以使用分号“;”隔开
 * @return {String} upload token string
 */
Qiniu.prototype.uploadToken = function uploadToken(options) {
  options = options || {};
  options.scope = options.scope || this.options.bucket;
  options.deadline = options.deadline || (utility.timestamp() + 3600);
  var flags = options;
  // 步骤2：将 Flags 进行安全编码
  var encodedFlags = utility.base64encode(JSON.stringify(flags), true);

  // 步骤3：将编码后的元数据混入私钥进行签名
  var signature = utility.hmac('sha1', this.options.secretKey, encodedFlags, 'base64');

  // 步骤4：将签名摘要值进行安全编码
  var encodedSign = signature.replace(/\//g, '_').replace(/\+/g, '-');
  // console.log('flags: %j, encodedFlags: %s, signature: %s, encodedSign: %s',
  //   flags, encodedFlags, signature, encodedSign);

  // 步骤5：连接各字符串，生成上传授权凭证
  return this.options.accessKey + ':' + encodedSign + ':' + encodedFlags;
};

/**
 * Upload file content
 * 
 * @param {String|Buffer|Stream} file content string or buffer, or a Stream instance.
 * @param {Object} [options]
 *  - {String} [key] 标识文件的索引，所在的存储空间内唯一。key可包含斜杠，但不以斜杠开头，比如 a/b/c.jpg 是一个合法的key。
 *                   若不指定 key，缺省使用文件的 etag（即上传成功后返回的hash值）作为key；
 *                   此时若 UploadToken 有指定 returnUrl 选项，则文件上传成功后跳转到 returnUrl?query_string, 
 *                   query_string 包含key={FileID}
 *  - {String} [x:custom_field_name] 自定义变量，必须以 x: 开头命名，不限个数。
 *                                   可以在 uploadToken 的 callbackBody 选项中使用 $(x:custom_field_name) 求值。
 *  - {String} [filename]
 *  - {String} [contentType]
 *  - {Number} [size]
 * @param {Function(err, result)} callback
 */
Qiniu.prototype.upload = function upload(content, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = null;
  }
  options = options || {};
  options.filename = options.filename || options.key || 'file';

  var form = content;
  if (!(content instanceof FormStream)) {
    form = new FormStream();
    if (typeof content === 'string') {
      form.buffer('file', new Buffer(content), options.filename, options.contentType);
    } else if (Buffer.isBuffer(content)) {
      form.buffer('file', content, options.filename, options.contentType);
    } else {
      // stream
      form.stream('file', content, options.filename, options.contentType, options.size);
    }
  }

  form.field('token', this.uploadToken());

  if (options.key) {
    form.field('key', options.key);
  }

  for (var k in options) {
    if (k.indexOf('x:') === 0) {
      form.field(k, options[k]);
    }
  }
  var headers = form.headers();
  var req = urllib.request(this._uploadURL, {
    method: 'POST',
    dataType: 'json',
    headers: headers,
    timeout: options.timeout || this.options.timeout,
  }, function (err, data, res) {
    if (err) {
      return callback(err, data, res);
    }
    var statusCode = res.statusCode;
    if (statusCode >= 400) {
      var msg = data && data.error || ('status ' + statusCode);
      err = new Error(msg);
      if (statusCode >= 400 && statusCode < 500) {
        err.name = 'QiniuClientAuthError';
      } else {
        err.name = 'QiniuServerError';
      }
      return callback(err, data, res);
    }
    
    callback(null, data, res);
  });

  // console.log(headers)
  // form.on('data', function (data) {
  //   console.log(data.toString())
  // })
  form.pipe(req);
};

module.exports = Qiniu;
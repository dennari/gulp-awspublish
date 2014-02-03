var Readable = require('stream').Readable,
    through = require('through2'),
    zlib = require('zlib'),
    crypto = require('crypto'),
    knox = require('knox'),
    mime = require('mime'),
    gutil = require('gulp-util');

/**
 * calculate file hash
 * @param  {Buffer} buf
 * @return {String}
 *
 * @api private
 */

function md5Hash(buf) {
  return crypto
    .createHash('md5')
    .update(buf)
    .digest('hex');
}

/**
 * init file with s3 info
 * @param  {Vinyl} file file object
 *
 * @return {Vinyl} file
 * @api private
 */

function initFile(file) {
  if (!file.s3) {
    file.s3 = {};
    file.s3.headers = {};
    file.s3.path = file.path.replace(file.base, '');
    if (file.s3.path[0] !== '/') file.s3.path = '/' + file.s3.path;
  }
  return file;
}

/**
 * gzip a file and approriate header to vinyl file
 * @see https://github.com/gulpjs/gulp/blob/master/docs/writing-a-plugin/README.md
 * @param  {Object} param
 *
 * @return {Stream}
 * @api public
 */

module.exports.gzip = function() {
  return through.obj(function (file, enc, cb) {

    // Do nothing if no contents
    if (file.isNull()) return cb();

    // streams not supported
    if (file.isStream()) {
      this.emit('error',
        new gutil.PluginError('gulp-awspublish', 'Stream content is not supported'));
      return cb();
    }

    // check if file.contents is a `Buffer`
    if (file.isBuffer()) {

      file = initFile(file.clone());

      // add content-type header
      file.s3.headers['Content-Encoding'] = 'gzip';

      // zip file
      zlib.gzip(file.contents, function(err, buf) {
        if (err) return cb(err);
        file.path += 'gz';
        file.contents = buf;
        cb(err, file);
      });
    }
  });
};

/**
 * create a reporter
 */

module.exports.reporter = function() {
  return require('./log-reporter')();
};

/**
 * create a new Publisher
 * @param {Object} knox option object
 *
 * options keys are:
 *   key: amazon key,
 *   secret: amazon secret,
 *   bucket: amazon bucket
 */

function Publisher(config) {
  this.client = knox.createClient(config);
}

/**
 * Publish a file to amazon s3
 * @see https://github.com/gulpjs/gulp/blob/master/docs/writing-a-plugin/README.md
 * @headers {Object} headers
 *
 * @return {Stream}
 * @api public
 */

Publisher.prototype.publish = function (headers) {

  var client = this.client;

  // init param object
  if (!headers) headers = {};

  // add public-read header by default
  if(!headers['x-amz-acl']) headers['x-amz-acl'] = 'public-read';

  return through.obj(function (file, enc, cb) {
    var header;


    // Do nothing if no contents
    if (file.isNull()) return cb();

    // streams not supported
    if (file.isStream()) {
      this.emit('error',
        new gutil.PluginError('gulp-awspublish', 'Stream content is not supported'));
      return cb();
    }

    // check if file.contents is a `Buffer`
    if (file.isBuffer()) {

      file = initFile(file);

      // file is marked as delete - stop here
      if (file.s3.state === 'delete') return cb(null, file);

      // add content-type header
      file.s3.headers['Content-Type'] = mime.lookup(file.path);

      // add content-length header
      file.s3.headers['Content-Length'] = file.contents.length;

      // add extra headers
      for (header in headers) file.s3.headers[header] = headers[header];

      // get s3 headers
      client.headFile(file.s3.path, function(err, res) {
        if (err) return cb(err);

        // calculate and check file etag
        var identical = ('"' + md5Hash(file.contents) + '"') === res.headers.etag;

        // skip: file are identical
        if (identical) {
          file.s3.state = 'skip';
          cb(err, file);

        // update: file are different
        } else if (res.headers.etag) {
          file.s3.state = 'update';
          client.putBuffer(file.contents, file.s3.path, file.s3.headers, function(err) {
            cb(err, file);
          });

        // add: file does not exist
        } else {
          file.s3.state = 'add';
          client.putBuffer(file.contents, file.s3.path, file.s3.headers, function(err) {
            cb(err, file);
          });
        }
      });
    }
  });
};

/**
 * Sync file in stream with file in the s3 bucket
 *
 * Sync method will
 * - buffer file in the stream
 * - read file in the s3 bucket
 * - delete s3 file that are in the bucket but not in the stream
 * - create a new stream with deleted and buffered files
 */

Publisher.prototype.sync = function(stream) {
  var client = this.client,
      rs = new Readable({ objectMode : true });

  rs._read = function() {};

  client.list({}, function(err, data) {
    if (err) return rs.emit('error', err);

    // get file in the s3 bucket
    var s3Docs = data.Contents.map(function(item) { return item.Key; });

    // add file to stream and mark file we dont want to delete
    stream.on('data', function(file) {
      file = initFile(file);
      delete s3Docs[s3Docs.indexOf(file.s3.path)];
      rs.push(file);
    });

    // add files to delete to stream and trigger a request to delete them
    stream.on('end', function() {
      s3Docs.forEach(function (s3path) {
        var file = new gutil.File({});
        file.s3 = {path: s3path, state: 'delete', headers: {} };
        rs.push(file);
      });

      client.deleteMultiple(s3Docs, function(err) {
        if (err) return rs.emit('error', err);
        rs.push(null);
      });
    });
  });

  return rs;
};


/**
 * Shortcut for `new Publisher()`.
 *
 * @param {Object} options
 * @see Client()
 * @api public
 */

exports.create = function(options){
  return new Publisher(options);
};

'use strict';
var fs = require('fs');
var util = require('util');
var events = require('events');
var path = require('path');
var urlMod = require('url');
var spawn = require('child_process').spawn;
var _ = require('lodash');
var assign = require('object-assign');
var base64 = require('base64-stream');
var date = require('easydate');
var eachAsync = require('each-async');
var fileUrl = require('file-url');
var getRes = require('get-res');
var memoize = require('memoize-async');
var phantomjs = require('phantomjs').path;
var slugifyUrl = require('slugify-url');
var viewport = require('viewport-list');
var mkdirp = require('mkdirp');
var logSymbols = require('log-symbols');
var parseCookiePhantomjs = require('parse-cookie-phantomjs');

util.inherits(Pageres, events.EventEmitter);

/**
 * Initialize Pageres
 *
 * @param {Object} options
 * @api public
 */

function Pageres(options) {
	if (!(this instanceof Pageres)) {
		return new Pageres();
	}

	this.stats = {};

	this.options = assign({}, options);
	this.options.filename = this.options.filename || '<%= url %>-<%= size %><%= crop %>';
	this.options.cookies = (this.options.cookies || []).map(function (el) {
		return typeof el === 'string' ? parseCookiePhantomjs(el) : el;
	});

	this._src = [];
	this._items = [];
	this._sizes = [];
	this._urls = [];
}

/**
 * Get or set page to capture
 *
 * @param {String} url
 * @param {Array} sizes
 * @param {Object} options
 * @api public
 */

Pageres.prototype.src = function (url, sizes, options) {
	if (!arguments.length) {
		return this._src;
	}

	this._src.push({
		url: url,
		sizes: sizes,
		options: options
	});

	return this;
};

/**
 * Get or set the destination directory
 *
 * @param {String} dir
 * @api public
 */

Pageres.prototype.dest = function (dir) {
	if (!arguments.length) {
		return this._dest;
	}

	this._dest = dir;
	return this;
};

/**
 * Run pageres
 *
 * @param {Function} cb
 * @api public
 */

Pageres.prototype.run = function (cb) {
	var self = this;

	if (!phantomjs) {
		cb('The automatic install of PhantomJS, which is used for generating the screenshots, seems to have failed.\nTry installing it manually: http://phantomjs.org/download.html');
		return;
	}

	eachAsync(this.src(), function (src, i, next) {
		var options = assign({}, self.options, src.options);
		var sizes = _.uniq(src.sizes.filter(/./.test, /^\d{3,4}x\d{3,4}$/i));
		var keywords = _.difference(src.sizes, sizes);

		if (!src.url) {
			cb(new Error('URL required'));
			return;
		}

		self._urls.push(src.url);

		if (!sizes.length && keywords.indexOf('w3counter') !== -1) {
			self._resolution(src.url, options, next);
			return;
		}

		if (keywords.length) {
			self._viewport(src.url, sizes, keywords, options, next);
			return;
		}

		sizes.forEach(function (size) {
			self._sizes.push(size);
			self._items.push(self._generate(src.url, size, options));
		});

		next();
	}, function (err) {
		if (err) {
			cb(err);
			return;
		}

		self.stats.screenshots = _.uniq(self._sizes).length;
		self.stats.urls = _.uniq(self._urls).length;

		if (!self.dest()) {
			cb(null, self._items);
			return;
		}

		self._save(self._items, cb);
	});
};

/**
 * Fetch ten most popular resolutions
 *
 * @param {String} url
 * @param {Function} cb
 * @param {Object} options
 * @api private
 */

Pageres.prototype._resolution = function (url, options, cb) {
	var self = this;
	var g = memoize(getRes);

	g(function (err, res) {
		if (err) {
			cb(err);
			return;
		}

		self._resolutions = res;

		res.forEach(function (size) {
			self._sizes.push(size.item);
			self._items.push(self._generate(url, size.item, options));
		});

		cb();
	});
};

/**
 * Fetch keywords
 *
 * @param {String} url
 * @param {Array} sizes
 * @param {Array} keywords
 * @param {Object} options
 * @param {Function} cb
 * @api private
 */

Pageres.prototype._viewport = function (url, sizes, keywords, options, cb) {
	var self = this;
	var v = memoize(viewport);

	v(keywords, function (err, res) {
		if (err) {
			cb(err);
			return;
		}

		res.forEach(function (r) {
			self._sizes.push(r.size);
			sizes.push(r.size);
		});

		_.uniq(sizes).forEach(function (size) {
			self._items.push(self._generate(url, size, options));
		});

		cb();
	});
};

/**
 * Save screenshots
 *
 * @param {Array} items
 * @param {Function} cb
 * @api private
 */

Pageres.prototype._save = function (items, cb) {
	var self = this;

	eachAsync(items, function (item, i, next) {
		mkdirp(self.dest(), function (err) {
			if (err) {
				next(err);
				return;
			}

			var stream = item.pipe(fs.createWriteStream(path.join(self.dest(), item.filename)));

			item.on('warn', self.emit.bind(self, 'warn'));
			item.on('error', next);
			stream.on('finish', next);
			stream.on('error', next);
		});
	}, function (err) {
		if (err) {
			cb(err);
			return;
		}

		cb(null, items);
	});
};

/**
 * Generate screenshots
 *
 * @param {String} url
 * @param {String} size
 * @param {Object} options
 * @api private
 */

Pageres.prototype._generate = function (url, size, options) {
	var isFile = fs.existsSync(url);
	var filename;
	var newUrl;

	if (isFile) {
		newUrl = fileUrl(url);
	} else {
		newUrl = url.replace(/^localhost/, 'http://$&');
		newUrl = urlMod.parse(newUrl).protocol ? newUrl : 'http://' + newUrl;
	}

	filename = _.template(options.filename + '.png', {
		url: slugifyUrl(isFile ? url : newUrl).replace(/^(?:https?:\/\/)?www\./, ''),
		size: size,
		crop: options.crop ? '-cropped' : '',
		date: date('Y-M-d')
	});

	var stream = this._phantom(assign({ delay: 0 }, options, {
		url: newUrl,
		width: size.split(/x/i)[0],
		height: size.split(/x/i)[1]
	}));

	stream.filename = filename;
	return stream;
};

/**
 * Run Phantom JS
 *
 * @param {Object} options
 * @api private
 */

Pageres.prototype._phantom = function (options) {
	var cp = spawn(phantomjs, [
		path.join(__dirname, 'converter.js'),
		JSON.stringify(options),
		'--ignore-ssl-errors=true',
		'--local-to-remote-url-access=true'
	]);
	var stream = cp.stdout.pipe(base64.decode());

	process.stderr.setMaxListeners(0);

	cp.stderr.setEncoding('utf8');
	cp.stderr.on('data', function (data) {
		if (/ phantomjs\[/.test(data)) {
			return;
		}

		if (/^WARN: /.test(data)) {
			stream.emit('warn', data.replace(/^WARN: /, ''));
			return;
		}

		if (data.trim().length) {
			stream.emit('error', new Error(data));
		}
	});

	return stream;
};

/**
 * Success message
 *
 * @api private
 */

Pageres.prototype._logSuccessMessage = function () {
	var i = this._sizes.length;
	var s = this.stats.screenshots;
	var u = this.stats.urls;

	console.log('\n' + logSymbols.success + ' Successfully generated %d screenshots from %d %s and %d %s', i, u, (u === 1 ? 'url' : 'urls'), s, (s === 1 ? 'resolution': 'resolutions'));
};

module.exports = Pageres;

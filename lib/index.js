/**
 * Export `Crawler`
 */

module.exports = Crawler;

/**
 * Module Dependencies
 */

var Emitter = require('emitter-component');
var context = require('http-context');
var delegate = require('delegates');
var parse = require('url').parse;
var cheerio = require('cheerio');
var selectn = require('selectn');
var enqueue = require('enqueue');
var yieldly = require('yieldly');
var wrapfn = require('wrap-fn');
var isArray = Array.isArray;
var ms = require('ms');

/**
 * Debug
 */

var debug = require('debug')('x-ray-crawler');

/**
 * Locals
 */

var absolutes = require('./absolute-path');
var rate_limit = require('./rate-limit');
var select = require('./select');
var range = require('./range');
var driver = require('./http');

/**
 * Initialize a `Crawler`
 *
 * @param {String} url
 * @return {Crawler}
 * @api public
 */

function Crawler(url) {
  if (!(this instanceof Crawler)) return new Crawler(url);

  // default state
  this.state = {
    response: function(){},
    paginate: function(){},
    throttle: rate_limit(),
    request: function(){},
    driver: driver(),
    delay_to: false,
    limit: Infinity,
    delay: range(),
    timeout: false,
    throws: false,
    url: url
  };
}

/**
 * Mixin `Emitter`
 */

Emitter(Crawler.prototype);

/**
 * Delegates
 */

delegate(Crawler.prototype, 'state')
  .fluent('concurrency')
  .fluent('response')
  .fluent('request')
  .fluent('driver')
  .fluent('throws')
  .fluent('limit')
  .getter('url');

/**
 * Throttle according to a rate limit
 *
 * @param {Number|String} requests
 * @param {Number|String} rate
 * @return {Number|Crawler}
 * @api public
 */

Crawler.prototype.throttle = function(requests, rate) {
  if (!arguments.length) return this.state.throttle;
  else if (1 == arguments.length) rate = requests, requests = 1;
  rate = /^\d/.test(rate) ? rate : 1 + rate;
  rate = 'string' == typeof rate ? ms(rate) : rate;
  this.state.throttle = rate_limit(requests, rate);
  return this;
};

/**
 * Delay subsequent requests
 *
 * @param {String|Number} from
 * @param {String|Number} to (optional)
 * @return {Number|Crawler}
 * @api public
 */

Crawler.prototype.delay = function(from, to) {
  if (!arguments.length) return this.state.delay;
  from = 'string' == typeof from ? ms(from) : from;
  to = 'string' == typeof to ? ms(to) : to;
  this.state.delay = range(from, to);
  return this;
};

/**
 * Specify a request timeout
 *
 * @param {String|Number} timeout
 * @return {Number|Crawler}
 * @api public
 */

Crawler.prototype.timeout = function(timeout) {
  if (!arguments.length) return this.state.timeout;
  timeout = 'string' == typeof timeout ? ms(timeout) : timeout;
  this.state.timeout = timeout;
  return this;
};


/**
 * Paginate through responses
 *
 * @param {String|Function} fn
 * @return {String|Function|Crawler}
 * @api public
 */

Crawler.prototype.paginate = function(fn) {
  if (!arguments.length) return this.state.paginate;

  this.state.paginate = 'function' != typeof fn
    ? compile
    : fn;

  function compile($, ctx) {
    var response = ctx.response;
    if (response.is('html') || response.is('xml')) {
      return select($, fn);
    } else if (response.is('json')) {
      return json_select(fn, $);
    } else {
      return [];
    }
  }

  return this;
};

/**
 * Initiate the crawl
 *
 * @param {Function} done (optional)
 * @return {Crawl|Generator}
 * @api public
 */

Crawler.prototype.crawl = yieldly(function(done) {
  done = done || noop;

  var limit = this.paginate() ? this.limit() : 1;
  var concurrency = this.concurrency();
  var paginate = this.paginate();
  var throttle = this.throttle();
  var throws = this.throws();
  var delay = this.delay();
  var url = this.url;
  var scheduled = 0;
  var self = this;
  var tid = {};

  // initial request
  debug('initial request: %s', url);

  // queue options
  var options = {
    concurrency: this.concurrency(),
    timeout: this.timeout(),
    limit: limit
  };

  // setup the queue
  var queue = enqueue(function(url, next) {
    self.get(url, next);
  }, options);

  // kick us off
  scheduled++;
  queue(url, onjobfinish(url));

  // handle the response
  function onresponse(ctx) {
    var response = ctx.response;
    var isJSON = response.is('json');
    var isHTML = response.is('html');
    var isXML = response.is('xml');
    var urls = [];
    var $;

    debug('response: %j', {
      url: ctx.url,
      status: ctx.status,
      type: ctx.type
    });

    // load response
    if (isHTML || isXML) {
      $ = cheerio.load(ctx.body, { xmlMode: isXML });
      $ = absolutes(ctx.url, $);
    } else {
      $ = ctx.body;
    }

    // send a response
    self.emit('response', $, ctx);

    // where we going next?
    var next_page = paginate($, ctx);
    if (next_page) {
      debug('next page(s): %j', next_page)
      urls = urls.concat(next_page).filter(canRequest);
    }

    // queue up the next round of urls
    if (urls.length) {
      urls.forEach(schedule);
    } else {
      debug('no next page, finishing up.')
    }
  }

  // schedule the next url
  function schedule(url) {
    // if we've reached the limit, don't request anymore
    if (--limit <= 0) return;
    // if specified, throttle requests and add a delay
    var wait = throttle() + delay();
    debug('queued "%s", waiting "%sms"', url, wait);

    scheduled++;
    setTimeout(function() {
      // queue up next request
      var queued = queue(url, onjobfinish(url));
      if (!queued) return;
    }, wait);
  }

  // handle jobs finishing
  function onjobfinish(url) {
    return function(err, ctx) {
      if (err) {
        debug('job (%s) error: %s', url, err.message);
        err.url = url;
        self.emit('error', err);
      } else if (ctx) {
        onresponse(ctx);
        debug('job finished: %s', url);
      }

      if (--scheduled <= 0) {
        return done();
      }
    }
  }

  return this;
});

/**
 * Make a request using the
 * specified driver
 *
 * @param {String} url
 * @param {Function} fn
 * @return {Crawler}
 * @api private
 */

Crawler.prototype.get = function(url, fn) {
  var response = this.response();
  var request = this.request();
  var driver = this.driver();
  var ctx = context();
  ctx.url = url;

  // pre-flight. modify the request
  request(ctx.request);

  // call the driver
  debug('request %j', {
    driver: driver.name,
    url: url
  });

  // short circuit the driver for testing
  if (ctx.body) {
    done(null, ctx);
  } else {
    wrapfn(driver, done)(ctx);
  }

  function done(err, res) {
    if (err) {
      return fn(err);
    }

    // update the context
    if (res && res != ctx) ctx.body = res;

    // post-flight. modify the response
    response(ctx.response);

    fn(null, ctx);
  }

  return this;
};

/**
 * Query a JSON object
 *
 * @param {String} selector
 * @param {Object} json
 * @return {String|Array}
 */

function json_select(selector, json) {
  return isArray(json)
    ? json.map(function(obj) { return selectn(selector, obj); })
    : selectn(selector, obj);
}

/**
 * Can we make a request?
 *
 * @param {String} url
 * @return {Boolean}
 */

function canRequest(url) {
  return 'string' == typeof url
    ? parse(url).protocol
    : false;
}
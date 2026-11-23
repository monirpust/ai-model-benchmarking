'use strict';
// Public API of GenBench (usable as a library without the web UI).
module.exports = {
  ...require('./config/loader'),
  ...require('./space/space'),
  ...require('./space/prefilter'),
  ...require('./providers'),
  ...require('./data/dataset'),
  ...require('./pipeline/runner'),
  stats: require('./util/stats'),
};

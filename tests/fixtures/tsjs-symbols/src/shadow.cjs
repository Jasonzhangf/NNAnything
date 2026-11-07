function wrap(module, exports) {
  module.exports = () => {};
  exports.hidden = 1;
}
const exports = {};
exports.localOnly = 2;

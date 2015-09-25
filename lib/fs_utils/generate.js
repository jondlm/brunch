'use strict';
const debug = require('debug')('brunch:generate');
const basename = require('path').basename;
const waterfall = require('async-waterfall');
const anysort = require('anysort');
const common = require('./common');
const smap = require('source-map');

const SourceMapConsumer = smap.SourceMapConsumer;
const SourceMapGenerator = smap.SourceMapGenerator;
const SourceNode = smap.SourceNode;


/* Sorts by pattern.
 *
 * Examples
 *
 *   sort ['b.coffee', 'c.coffee', 'a.coffee'],
 *     before: ['a.coffee'], after: ['b.coffee']
 *   # ['a.coffee', 'c.coffee', 'b.coffee']
 *
 * Returns new sorted array.
 */

const sortByConfig = function(files, config) {
  var criteria;
  if (toString.call(config) === '[object Object]') {
    criteria = [
      config.before || [], config.after || [], config.joinToValue || [], config.bower || [], config.component || [], config.vendorConvention || (function() {
        return false;
      })
    ];
    return anysort.grouped(files, criteria, [0, 2, 3, 4, 5, 6, 1]);
  } else {
    return files;
  }
};

const flatten = function(array) {
  return array.reduce(function(acc, elem) {
    return acc.concat(Array.isArray(elem) ? flatten(elem) : [elem]);
  }, []);
};

const extractOrder = function(files, config) {
  var after, before, bower, component, conventions, orders, packageInfo, ref, types, vendorConvention;
  types = files.map(function(file) {
    return file.type + 's';
  });
  orders = Object.keys(config.files).filter(function(key) {
    return types.indexOf(key) >= 0;
  }).map(function(key) {
    return config.files[key].order || {};
  });
  before = flatten(orders.map(function(type) {
    return type.before || [];
  }));
  after = flatten(orders.map(function(type) {
    return type.after || [];
  }));
  ref = config._normalized, conventions = ref.conventions, packageInfo = ref.packageInfo;
  vendorConvention = conventions.vendor;
  bower = packageInfo.bower.order;
  component = packageInfo.component.order;
  return {
    before: before,
    after: after,
    vendorConvention: vendorConvention,
    bower: bower,
    component: component
  };
};

const sort = function(files, config, joinToValue) {
  var indexes, order, paths;
  paths = files.map(function(file) {
    return file.path;
  });
  indexes = Object.create(null);
  files.forEach(function(file, index) {
    return indexes[file.path] = file;
  });
  order = extractOrder(files, config);
  if (Array.isArray(joinToValue)) {
    order.joinToValue = joinToValue;
  }
  return sortByConfig(paths, order).map(function(path) {
    return indexes[path];
  });
};


/* New. */

const concat = function(files, path, type, definition, aliases, autoRequire) {
  var root;
  if (aliases == null) {
    aliases = [];
  }
  if (autoRequire == null) {
    autoRequire = [];
  }

  /* nodes = files.map toNode */
  root = new SourceNode();
  debug("Concatenating " + (files.map(function(_) {
    return _.path;
  }).join(', ')) + " to " + path);
  files.forEach(function(file) {
    var data;
    root.add(file.node);
    data = file.node.isIdentity ? file.data : file.source;
    if (type === 'javascript' && ';' !== data.trim().substr(-1)) {
      root.add(';');
    }
    return root.setSourceContent(file.node.source, data);
  });
  if (type === 'javascript') {
    root.prepend(definition(path, root.sourceContents));
  }
  aliases.forEach(function(alias) {
    var key;
    key = Object.keys(alias)[0];
    return root.add("require.alias('" + key + "', '" + alias[key] + "');");
  });
  autoRequire.forEach(function(require) {
    return root.add("require('" + require + "');");
  });
  return root.toStringWithSourceMap({
    file: path
  });
};

const mapOptimizerChain = function(optimizer) {
  return function(params, next) {
    var code, data, map, optimizerArgs, path, sourceFiles;
    data = params.data, code = params.code, map = params.map, path = params.path, sourceFiles = params.sourceFiles;
    debug("Optimizing '" + path + "' with '" + optimizer.constructor.name + "'");
    optimizerArgs = (function() {
      if (optimizer.optimize.length === 2) {

        /* New API: optimize({data, path, map}, callback) */
        return [params];
      } else {

        /* Old API: optimize(data, path, callback) */
        return [data, path];
      }
    })();
    optimizerArgs.push(function(error, optimized) {
      var newMap, optimizedCode, optimizedMap;
      if (error != null) {
        return next(error);
      }
      if (toString.call(optimized) === '[object Object]') {
        optimizedCode = optimized.data;
        optimizedMap = optimized.map;
      } else {
        optimizedCode = optimized;
      }
      if (optimizedMap != null) {
        newMap = SourceMapGenerator.fromSourceMap(new SourceMapConsumer(optimizedMap));
        if (newMap._sourcesContents == null) {
          newMap._sourcesContents = {};
        }
        sourceFiles.forEach(function(arg) {
          var path, source;
          path = arg.path, source = arg.source;
          return newMap._sourcesContents["$" + path] = source;
        });
      } else {
        newMap = map;
      }
      return next(error, {
        data: optimizedCode,
        code: optimizedCode,
        map: newMap,
        path: path,
        sourceFiles: sourceFiles
      });
    });
    return optimizer.optimize.apply(optimizer, optimizerArgs);
  };
};

const optimize = function(data, map, path, optimizers, sourceFiles, callback) {
  var first, initial;
  initial = {
    data: data,
    code: data,
    map: map,
    path: path,
    sourceFiles: sourceFiles
  };
  first = function(next) {
    return next(null, initial);
  };
  return waterfall([first].concat(optimizers.map(mapOptimizerChain)), callback);
};

const jsTypes = ['javascript', 'template'];

const generate = function(path, sourceFiles, config, optimizers, callback) {
  var code, joinKey, joinToValue, len, map, mapPath, ref, sorted, type, withMaps;
  type = sourceFiles.some(function(file) {
    return jsTypes.indexOf(file.type) >= 0;
  }) ? 'javascript' : 'stylesheet';
  optimizers = optimizers.filter(function(optimizer) {
    return optimizer.type === type;
  });
  len = config.paths["public"].length + 1;
  joinKey = path.slice(len);
  joinToValue = config.files[type + "s"].joinTo[joinKey];
  sorted = sort(sourceFiles, config, joinToValue);
  ref = concat(sorted, path, type, config._normalized.modules.definition, config._normalized.packageInfo.component.aliases, config._normalized.modules.autoRequire[joinKey]), code = ref.code, map = ref.map;
  withMaps = map && config.sourceMaps;
  mapPath = path + ".map";
  return optimize(code, map, path, optimizers, sourceFiles, function(error, data) {
    var controlChar, mapRoute;
    if (error != null) {
      return callback(error);
    }
    if (withMaps) {
      mapRoute = config.sourceMaps === 'absoluteUrl' ? mapPath.replace(config.paths["public"], '').replace('\\', '/') : basename(mapPath);
      controlChar = config.sourceMaps === 'old' ? '@' : '#';
      data.code += type === 'javascript' ? "\n//" + controlChar + " sourceMappingURL=" + mapRoute : "\n/*" + controlChar + " sourceMappingURL=" + mapRoute + "*/";
    }
    return common.writeFile(path, data.code, function() {
      if (withMaps) {
        return common.writeFile(mapPath, data.map.toString(), callback);
      } else {
        return callback();
      }
    });
  });
};

generate.sortByConfig = sortByConfig;

module.exports = generate;
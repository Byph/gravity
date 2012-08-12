/*global Buffer, global, module, require*/
(function () {

	// Make a module
	var gravity = (function (name) {
		var root = typeof window !== 'undefined' ? window : global,
			had = Object.prototype.hasOwnProperty.call(root, name),
			prev = root[name], me = root[name] = {};
		if (typeof module !== 'undefined' && module.exports) {
			module.exports = me;
		}
		me.noConflict = function () {
			root[name] = had ? prev : undefined;
			if (!had) {
				try {
					delete root[name];
				} catch (ex) {
				}
			}
			return this;
		};
		return me;
	}('gravity'));

	gravity.VERSION = '0.6.1';

	var
		atom = require('./atom/atom'),
		http = require('http'),
		url = require('url'),
		fs = require('fs'),

		// Functions
		isArray = Array.isArray || function (obj) {
			return Object.prototype.toString.call(obj) === '[object Array]';
		},
		packResources
	;

	function hasExtension(path, ext) {
		return path.substr(path.length - ext.length) === ext;
	}

	function isURL(str) {
		return !!str.match(/^https?:\/\//);
	}


	// Add JavaScript line-hint comments to every 10th line of a file.
	function addLineHints(name, content) {
		var
			i = -1,
			lines = content.split('\n'),
			len = lines.length,
			out = []
		;
		while (++i < len) {
			out.push(lines[i] +
				((i % 10 === 9) ? ' //' + name + ':' + (i + 1) + '//' : ''));
		}
		return out.join('\n');
	}


	// Concatentate an array of Buffers into a single one.
	function joinBuffers(buffers) {
		var
			i = -1, j = -1,
			num = buffers.length,
			totalBytes = 0,
			bytesWritten = 0,
			buff,
			superBuff
		;
		while (++i < num) {
			totalBytes += buffers[i].length;
		}
		superBuff = new Buffer(totalBytes);
		while (++j < num) {
			buff = buffers[j];
			buff.copy(superBuff, bytesWritten, 0);
			bytesWritten += buff.length;
		}
		return superBuff;
	}


	// Given a web URL, fetch the file contents.
	function wget(fileURL, callback) {
		var chunks = [], parsed = url.parse(fileURL);
		http.get(
			{
				host: parsed.host,
				port: parsed.port || 80,
				path: parsed.pathname
			},
			function (res) {
				res.on('data', function (chunk) {
					chunks.push(chunk);
				}).on('end', function () {
					callback(null, joinBuffers(chunks));
				});
			}
		);
	}


	// Given a resource path, return an enumeration of the possible ways to split
	// the path at '/' boundaries, in order of specificity. For instance, the path
	// 'assets/images/foo.png' would be broken down like so:
	//
	//  [ [ 'assets/images/foo.png', '' ],
	//    [ 'assets/images', 'foo.png' ],
	//    [ 'assets', 'images/foo.png' ],
	//    [ '', 'assets/images/foo.png' ] ]
	//
	function getResourcePathSplits(path) {
		var
			parts = path.split('/'),
			i = parts.length,
			splits = [[path, '']]
		;
		while (--i >= 0) {
			splits.push([
				parts.slice(0, i).join('/'),
				parts.slice(i).join('/')
			]);
		}
		return splits;
	}


	// Given a map and a resource path, drill down in the map to find the most
	// specific map node that matches the path.  Return the map node, the matched
	// path prefix, and the unmatched path suffix.
	function reduce(map, path) {
		var mapNode, prefix, split, splits = getResourcePathSplits(path),
			subValue, suffix;
		while (splits.length) {
			split = splits.shift();
			prefix = split[0];
			suffix = split[1];
			mapNode = map[prefix];
			if (mapNode) {
				if (!suffix || typeof mapNode === 'string') {
					return { map: mapNode, prefix: prefix, suffix: suffix };
				}
				if (typeof mapNode === 'object') {
					subValue = reduce(mapNode, suffix);
					if (subValue) {
						subValue.prefix = prefix + '/' + subValue.prefix;
						return subValue;
					}
				}
			}
		}
		return { map: map, prefix: '', suffix: path };
	}

	// XXX TODO FIXME: remove this; shouldn't be part of public interface.
	gravity.reduce = reduce;


	// Given a local file path (relative to base), fetch the file contents.
	function getFile(base, path, callback, addLineHints) {
		var filePath = base + '/' + path;
		//console.log('getFile(' + filePath + ')');
		fs.stat(filePath, function (err, stat) {
			if (err || stat.isDirectory()) {
				callback({ code: 404, message: 'Not Found: ' + path });
			} else {
				fs.readFile(filePath, function (err, content) {
					callback(
						err ? { code: 500, message: 'Internal error' } : null,
						(addLineHints && hasExtension(filePath, '.js')) ?
							new Buffer(addLineHints(path, content + '')) : content
					);
				});
			}
		});
	}


	// Given a resource path, retrieve the associated content.  Internal requests
	// are always allowed, whereas external requests will only have access to
	// resources explicitly exposed by the gravity map.
	function getResource(map, base, internal, path, callback, addLineHints) {
		var
			reduced = reduce(map, path),
			reducedMap = reduced.map,
			reducedMapType = isArray(reducedMap) ? 'array' : typeof reducedMap,
			reducedPrefix = reduced.prefix,
			reducedSuffix = reduced.suffix,
			firstChar = path.charAt(0),
			temporary = firstChar === '~',
			literal = firstChar === '='
		;
		//console.log('getResource(' + internal + ', ' + path + ', ...)');

		if (literal) {
			callback(null, new Buffer(path.substr(1) + '\n'));

		} else if (temporary && !internal) {
			// External request for a temporary resource.
			callback({ code: 403, message: 'Forbidden' });

		} else if (reducedSuffix) {
			// We did NOT find an exact match in the map.

			if (!reducedPrefix && internal) {
				getFile(base, path, callback, addLineHints);
			} else if (reducedMapType === 'string') {
				getFile(base, reducedMap + '/' + reducedSuffix, callback, addLineHints);
			} else {
				callback({ code: 404, message: 'Not Found' });
			}

		} else {
			// We found an exact match in the map.

			if (reducedMap === reducedPrefix) {
				// This is just a local file/dir to expose.
				getFile(base, reducedPrefix, callback, addLineHints);

			} else if (reducedMapType === 'string') {
				// A string value may be a web URL.
				if (isURL(reducedMap)) {
					wget(reducedMap, callback);
				} else {
					// Otherwise, it's another resource path.
					getResource(map, base, true, reducedMap, callback, addLineHints);
				}

			} else if (reducedMapType === 'array') {
				// An array is a list of resources to get packed together.
				packResources(map, base, reducedMap, callback);

			//} else if (reducedMapType === 'object') {
				// An object is a directory. We could return a listing...
				// TODO: Do we really want to support listings?

			} else {
				// WTF?
				callback({ code: 500, message: 'gravity.map is whack.' });
			}
		}
	}


	// Given a list of resource paths, fetch the contents and concatenate them
	// together into a single blob.
	packResources = function (map, base, resources, callback) {
		var
			packer = atom.create(),
			i = -1,
			len = resources.length
		;

		function fetchFile(resource) {
			getResource(
				map,
				base,
				true,
				resource,
				function (err, content) {
					if (err) {
						callback(err);
					} else {
						packer.set(resource, content);
					}
				},
				addLineHints
			);
		}

		while (++i < len) {
			fetchFile(resources[i]);
		}

		packer.once(resources, function () {
			var j = -1, out = [], resource;
			out.push(new Buffer('// ----------\n// Packing:\n// ' +
				resources.join('\n// ') + '\n// ----------\n'));
			while (++j < len) {
				resource = resources[j];
				out.push(new Buffer('\n// Begin ' + resource + '\n'));
				out.push(arguments[j]);
				out.push(new Buffer('\n// End ' + resource + '\n\n'));
			}
			callback(null, joinBuffers(out));
		});
	};

	function stripComments(text) {
		var
			line,
			lines = text.split('\n'),
			i = -1,
			len = lines.length,
			out = []
		;
		while (++i < len) {
			line = lines[i];
			if (!line.match(/^\s*\/\//)) {
				out.push(line);
			}
		}
		return out.join('\n');
	}

	gravity.list = function (map, base, callback) {
	};

	gravity.map = function (uri, callback) {
		var gravMapJSON = stripComments(fs.readFileSync(uri) + '');
		callback(JSON.parse(gravMapJSON));
	};

	gravity.pull = function (map, base, path, callback) {
		getResource(map, base, false, path, callback);
	};

	gravity.serve = function (map, base, host, port) {
	};

}());
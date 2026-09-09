#!/usr/bin/env node
/**
 * End-to-end smoke test for pm2-zabbix.
 *
 * Starts a throwaway PM2 daemon in its own PM2_HOME, runs a dummy app under it,
 * and exercises the full data path against a stub Zabbix sender: LLD discovery,
 * the periodic process list, the PM2 daemon's own status, live bus events, and
 * the "PM2 is down" path.
 *
 * No Zabbix server and no zabbix_sender binary are required.
 * Run with: npm test
 */

var os = require('os');
var path = require('path');
var fs = require('fs');

// PM2_HOME must be set before anything requires pm2/paths, which reads it at load time.
// Keep the directory short: PM2's IPC sockets live inside it and AF_UNIX paths are
// capped at ~104 characters on macOS / ~108 on Linux.
var PM2_HOME = path.join(os.tmpdir(), 'pm2zbx-smoke');
process.env.PM2_HOME = PM2_HOME;

var pm2 = require('pm2');
var PM2Tracker = require('../lib/PM2Tracker');
var ZabbixDataProvider = require('../lib/ZabbixDataProvider');
var PM2ZabbixMonitor = require('../lib/PM2ZabbixMonitor');

var APP_NAME = 'pm2zbx-smoke-app';
var DUMMY = path.join(PM2_HOME, 'dummy.js');

var checks = 0;
var failures = [];

function assert(condition, description) {
	checks++;
	if (condition) {
		console.log('  ok   - ' + description);
	}
	else {
		failures.push(description);
		console.log('  FAIL - ' + description);
	}
}

function delay(ms) {
	return new Promise(function(resolve) {
		setTimeout(resolve, ms);
	});
}

function promisify(fn, context) {
	return function() {
		var args = Array.prototype.slice.call(arguments);
		return new Promise(function(resolve, reject) {
			args.push(function(error, result) {
				return error ? reject(error) : resolve(result);
			});
			fn.apply(context, args);
		});
	};
}

var pm2Connect = promisify(pm2.connect, pm2);
var pm2Start = promisify(pm2.start, pm2);
var pm2Restart = promisify(pm2.restart, pm2);
var pm2Kill = promisify(pm2.killDaemon, pm2);

// A stand-in for the real ZabbixSender: records what would have been sent.
function StubSender() {
	this.sent = [];
}
StubSender.prototype.send = function send(values, callback) {
	this.sent.push(values);
	callback(null, 'stub: ok');
};

function setUp() {
	fs.mkdirSync(PM2_HOME, { recursive: true });
	fs.writeFileSync(DUMMY, 'setInterval(function() {}, 1000);\n');
	return pm2Connect().then(function() {
		return pm2Start({ script: DUMMY, name: APP_NAME });
	});
}

function tearDown() {
	return pm2Kill().catch(function() {
		// Best effort - the daemon may already be gone.
		return null;
	});
}

function run() {
	var sender = new StubSender();
	var tracker = new PM2Tracker();
	var provider = new ZabbixDataProvider(sender);
	var monitor = new PM2ZabbixMonitor(tracker, provider, { monitor: true });
	var stateChanges = [];
	var processID;

	tracker.on('processStateChanged', function(changeEvent) {
		stateChanges.push(changeEvent);
	});

	console.log('pm2-zabbix smoke test (pm2 ' + require('pm2/package.json').version + ', PM2_HOME=' + PM2_HOME + ')');

	console.log('\n# discovery');
	return monitor.start().then(function() {
		var items = provider.getDiscoveryData().data;
		var ours = items.filter(function(item) {
			return item['{#PROCESS_NAME}'] === APP_NAME;
		});
		assert(ours.length === 1, 'the dummy app appears exactly once in the LLD payload');
		if (ours.length !== 1) {
			throw new Error('cannot continue without a discovered process');
		}
		processID = ours[0]['{#PROCESS_ID}'];
		assert(processID === APP_NAME + '-0', 'process ID is "<name>-<pm_id>" (got "' + processID + '")');

		console.log('\n# process list');
		return monitor.sendProcessList();
	}).then(function() {
		var payload = sender.sent[sender.sent.length - 1];
		var key = function(item) {
			return 'pm2.processes[' + processID + ',' + item + ']';
		};
		assert(payload[key('status')] === 'online', 'reports status "online" (got "' + payload[key('status')] + '")');
		assert(typeof payload[key('cpu')] === 'number', 'reports cpu as a number');
		assert(typeof payload[key('memory')] === 'number' && payload[key('memory')] > 0, 'reports non-zero memory');
		assert(payload[key('restarts')] === 0, 'reports a restart count of 0');

		console.log('\n# PM2 daemon status');
		return monitor.sendPM2Status();
	}).then(function() {
		var payload = sender.sent[sender.sent.length - 1];
		assert(payload['pm2.status'] === 'online', 'PM2 daemon reports "online"');
		assert(typeof payload['pm2.cpu'] === 'number', 'PM2 daemon reports cpu as a number');
		assert(payload['pm2.memory'] > 0, 'PM2 daemon reports non-zero memory');
		assert(payload['pm2.pid'] > 0, 'PM2 daemon reports a real PID');

		console.log('\n# live bus events');
		stateChanges.length = 0;
		return pm2Restart(APP_NAME).then(function() {
			return delay(3000);
		});
	}).then(function() {
		var statuses = stateChanges.map(function(change) {
			return change.newState.status;
		});
		assert(stateChanges.length > 0, 'a restart produces processStateChanged events (' + (statuses.join(',') || 'none') + ')');
		assert(statuses.indexOf('online') !== -1, 'the process settles back to "online"');
		assert(stateChanges.every(function(change) {
			return change.processID === processID;
		}), 'every event carries the expected process ID');

		console.log('\n# PM2 offline path');
		return tracker.stop().catch(function() {
			return null;
		}).then(tearDown).then(function() {
			return delay(1000);
		}).then(function() {
			return tracker.getPM2State();
		});
	}).then(function(state) {
		assert(state.status === 'offline', 'a dead PM2 daemon reports "offline" rather than throwing (got "' + state.status + '")');
		assert(state.pid === 0, 'a dead PM2 daemon reports PID 0');
		assert(state.resources.cpu === 0 && state.resources.memory === 0, 'a dead PM2 daemon reports zero resource usage');
	});
}

setUp()
	.then(run)
	.then(function() {
		return tearDown();
	}, function(error) {
		failures.push('threw: ' + ((error && error.stack) || error));
		console.log('\n  FAIL - unexpected error:\n' + ((error && error.stack) || error));
		return tearDown();
	})
	.then(function() {
		console.log('\n' + (checks - failures.length) + '/' + checks + ' checks passed');
		if (failures.length) {
			console.log('failed:');
			failures.forEach(function(failure) {
				console.log('  - ' + failure);
			});
		}
		process.exit(failures.length ? 1 : 0);
	});

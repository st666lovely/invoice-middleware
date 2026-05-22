"use strict";

const EventEmitter = require("events");

class DashboardEmitter extends EventEmitter {}

module.exports = new DashboardEmitter();

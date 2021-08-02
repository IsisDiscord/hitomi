const EventEmitter = require("events");
const Websocket = require("ws");

let Erlpack;

try {
  Erlpack = require("erlpack");
} catch {}

const Constants = require("../../utils/Constants")

module.exports = class Shard extends EventEmitter {
  constructor (manager, id) {
    super();

    this.id = id;

    this.sequence = -1;
    this.sessionId = null;
    this.lastHeartbeatAcked = true;
    this.heartbeatInterval = null;
    this.reconnectInterval = 3000;
    this.reconnectAttempts = 0;

    this.status = "IDLE";

    Object.defineProperty(this, "manager", { value: manager, writable: false });
    Object.defineProperty(this, "connection", { value: null, writable: true });
  }

  /**
  * Connects the shard and create a websocket connection for them.
  */
  connect() {
    // First you need to disconnect the shard.
    if (this.status !== "IDLE") return;

    this.connection = new Websocket(this.manager.websocketURL, { perMessageDeflate: false })

    this.status = "CONNECTED";

    this.connection.on("message", (message) => this.websocketMessageReceive(message));
    this.connection.on("open", () => this.websocketConnectionOpen());
    this.connection.on("error", (error) => this.websocketError(error));
    this.connection.on("close", (...args) => this.websocketCloseConnection(...args));
  }

  /**
  * Fired when websocket closes the connection
  * @param {Number} code The error code received
  * @param {String} reason Reason for the disconnect
  */
  async websocketCloseConnection(code, reason) {
    this.status = "CLOSED";

    this.emit("connectionClosed", code, reason, this.id);
    this.disconnect(true);
  }

  /**
  * Fired when occurs an error in the websocket connection.
  * @param {Error} error The error that occurred
  */
  async websocketError(error) {
    /**
    * Fired when an error occurs in a shard
    * @event Client#shardError
    * @prop {Error} error The error that occurred
    * @prop {Number} id The ID of the shard
    */
    this.manager.client.emit("shardError", error, this.id);
  }

  /**
  * Fired when websocket receives a message
  * @param {data} Message received from the websocket
  */
  websocketMessageReceive(data) {
    data = Erlpack ? Erlpack.unpack(data) : JSON.parse(data.toString());

    this.packetReceive(data);
  }

  /**
  * Fired when a connection with websocket opens.
  */
  async websocketConnectionOpen() {
    this.status = "OPEN";

    /**
    * Fired when the shard establishes a connection
    * @event Shard#connect
    * @prop {Number} id The ID of the shard
    */
    this.emit("connect", this.id);
    this.lastHeartbeatAck = true;
  }

  /**
  * Fired when a packate is received
  * @param {Object} packet The packet received
  */
  async packetReceive(packet) {
    if (packet.s) this.sequence = packet.s;

    switch (packet.t) {
      case "READY": {
        this.sessionId = packet.d.session_id;

        this.status = "READY";

        this.lastHeartbeatAcked = true;
        this.sendHeartbeat();
        break;
      }
    }

    switch (packet.op) {
      case Constants.OP_CODES.EVENT: return this.manager.handlePacket(packet, this);
      case Constants.OP_CODES.HEARTBEAT: return this.sendHeartbeat();
      case Constants.OP_CODES.HEARTBEAT_ACK: {
        this.lastHeartbeatAck = true;
        this.lastHeartbeatReceived = Date.now();

        break;
      }
      case Constants.OP_CODES.HELLO: {
        if (packet.d?.heartbeat_interval) {
          if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

          this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), packet.d.heartbeat_interval);
        }

        if (this.sessionId) {
          this.sendWebsocketMessage({
            op: Constants.OP_CODES.RESUME,
            d: {
              token: this.manager.client.token,
              session_id: this.sessionId,
              seq: this.sequence
            }
         });
       } else {
         this.identify();
         this.sendHeartbeat();
       }
       break;
      }
      case Constants.OP_CODES.INVALID_SESSION: {
        this.sessionId = null;
        this.sequence = 0;

        if (packet.d) return this.identify();

        break;
      }
    }
  }

  /**
  * Identify the connection. Required  for discord to recognize who is connecting
  */
  async identify() {
    const { client } = this.manager;

    const d = {
      token: client.token,
      intents: client.options.intents,
      shard: [this.id, client.options.shardCount],
      v: client.options.ws.version,
      properties: {
        os: process.platform,
        browser: "hitomi",
        device: "hitomi"
      }
    };

    return this.sendWebsocketMessage({ op: Constants.OP_CODES.IDENTIFY, d });
  }

  /**
  * Sends heartbeat to discord. Required to keep a connection
  */
  sendHeartbeat() {
    this.lastHeartbeatAcked = false;

    this.sendWebsocketMessage({ op: Constants.OP_CODES.HEARTBEAT, d: this.sequence });
  }

  /**
  * Send a message to the websocket
  * @param {Object} data Message to send
  * @param {Number} data.op Gateway OP code
  * @param {} data.d Data to send
  */
  sendWebsocketMessage(data) {
    const method = Erlpack ? Erlpack.pack : JSON.stringify;

    if (this.status !== "CLOSED")
      this.connection.send(method(data), (error) => {
        this.manager.client.emit("shardError", error, this.id);
      });
  }

  /**
  * Disconnect the shard
  * @param {Boolean} [reconnect] Whether to reconnect after disconnecting
  */
  disconnect(reconnect = false) {
    if (!this.connection) return;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);

      this.heartbeatInterval = null;
    }

    try {
      this.connection.terminate();
    } catch (error) {
      this.manager.client.emit("shardError", error, this.id);
    }

    this.connection = null;

    /**
    * Fired when the shard disconnects
    * @event Shard#disconnect
    * @prop {Error?} error The error that occurred
    */
    this.emit("disconnect", error);

    if (this.sessionId) this.sessionId = null;
    if (reconnect && this.manager.client.options.autoReconnect) {
      if (this.reconnectAttempts >= 5) return this.emit("disconnect", "Too many attempts");

      setTimeout(() => this.connect(), this.reconnectInterval);

      this.reconnectInterval = this.reconnectInterval + 3000;
      this.reconnectAttempts++;
    }
  }
}

import { Server } from "socket.io";
import cookie from "cookie";
import env from "../config/env.js";
import logger from "../config/logger.js";
import { verifyAccessToken } from "./tokens.js";
import { loadUser } from "../middleware/auth.js";
import { ForbiddenError } from "./errors.js";

/**
 * Realtime push layer (Socket.IO).
 *
 * REST endpoints stay authoritative: everything a participant can read over the
 * socket, they can also read from the API, and every mutation is validated by a
 * service first. The socket only *pushes* — it never accepts state changes.
 *
 * A SessionWorkspace client connects once, authenticates automatically via the
 * `lien_access` cookie, then subscribes to the room for each session it opens.
 * Subscriptions are re-checked against the database so merely knowing a session
 * id is never enough to receive its activity.
 *
 * The proxy is deliberately live-only: if the connection drops the client
 * re-synchronises by re-fetching authoritative state over HTTP (mirroring the
 * existing cursor/recovery pattern used by the REST API).
 */

let io = null;

export function getIo() {
  return io;
}

export function isRealtimeInitialized() {
  return io !== null;
}

/** Publish to every participant subscribed to a study session. No-op when idle. */
export function publishToSession(sessionId, event, payload) {
  if (!io) return;
  io.to(roomName(sessionId)).emit(event, { ...payload, sessionId: String(sessionId) });
}

const roomName = (sessionId) => `session:${sessionId}`;

function parseCookies(handshake) {
  const header = handshake?.headers?.cookie;
  return header ? cookie.parse(header) : {};
}

async function authenticateSocket(socket) {
  const cookies = parseCookies(socket.handshake);
  const token = cookies.lien_access;
  if (!token) throw new ForbiddenError("Missing access token.");

  const payload = verifyAccessToken(token);
  const user = await loadUser(payload.sub);
  if (!user || user.status !== "ACTIVE") throw new ForbiddenError("Account unavailable.");
  return user;
}

/**
 * Attach Socket.IO to an already-listening HTTP server.
 * Must be called once, after `app.listen()`.
 */
export function initRealtime(httpServer) {
  if (io) return io;

  io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigins,
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // ---- MIDDLEWARE: authenticate every connection ---------------------------
  io.use(async (socket, next) => {
    try {
      const user = await authenticateSocket(socket);
      socket.data.user = { id: user.id, name: `${user.first_name} ${user.last_name}`.trim() };
      next();
    } catch (error) {
      next(error);
    }
  });

  // ---- CONNECTION: subscriptions are validated per room ----------------------
  io.on("connection", (socket) => {
    logger.debug("socket connected", { userId: socket.data.user.id, socketId: socket.id });

    socket.on("session:join", async ({ sessionId } = {}, acknowledge) => {
      try {
        // Imported lazily to keep this module independent of service wiring and
        // to avoid circular imports at boot.
        const { canParticipateInSession } = await import("../services/studySession.service.js");
        const access = await canParticipateInSession(sessionId, socket.data.user.id);
        await socket.join(roomName(access.sessionId));
        acknowledge?.({ ok: true, sessionId: access.sessionId });
      } catch (error) {
        logger.warn("socket session join denied", {
          userId: socket.data.user.id,
          sessionId,
          code: error.code ?? "UNKNOWN",
        });
        acknowledge?.({ ok: false, code: error.code ?? "FORBIDDEN", message: error.message });
      }
    });

    socket.on("session:leave", ({ sessionId } = {}, acknowledge) => {
      socket.leave(roomName(sessionId));
      acknowledge?.({ ok: true });
    });

    socket.on("disconnect", () => {
      logger.debug("socket disconnected", { userId: socket.data.user.id, socketId: socket.id });
    });
  });

  logger.info("Realtime layer initialised", { rooms: "session:*" });
  return io;
}

export default { initRealtime, getIo, publishToSession, isRealtimeInitialized };
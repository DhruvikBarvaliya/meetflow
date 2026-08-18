import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { session } from '@/lib/session';
import { useAuth } from './AuthContext';

/**
 * Server → client event names, mirrored from `server/src/sockets/index.ts`.
 *
 * The server derives every room from the authenticated identity at connection
 * time; there is no join event, so a client cannot subscribe to anything it is
 * not already entitled to see.
 */
export const SOCKET_EVENTS = {
  connectionReady: 'connection.ready',
  appointmentCreated: 'appointment.created',
  appointmentUpdated: 'appointment.updated',
  appointmentCancelled: 'appointment.cancelled',
  appointmentRescheduled: 'appointment.rescheduled',
  appointmentCompleted: 'appointment.completed',
  appointmentNoShow: 'appointment.no_show',
  availabilityUpdated: 'availability.updated',
  staffAssigned: 'staff.assigned',
  waitlistSlotAvailable: 'waitlist.slot_available',
  dashboardMetricsUpdated: 'dashboard.metrics_updated',
  notificationCreated: 'notification.created',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

interface SocketContextValue {
  socket: Socket | null;
  status: SocketStatus;
}

const SocketContext = createContext<SocketContextValue | null>(null);

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? '';

export function SocketProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status: authStatus } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [status, setStatus] = useState<SocketStatus>('idle');

  useEffect(() => {
    if (authStatus !== 'authenticated') {
      setStatus('idle');
      return undefined;
    }

    const token = session.getAccessToken();
    if (!token) return undefined;

    const instance = io(SOCKET_URL, {
      path: '/socket.io',
      // The server reads the handshake `auth.token`; an expired one is rejected
      // during the handshake rather than after a room join.
      auth: { token },
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });

    setSocket(instance);
    setStatus('connecting');

    instance.on('connect', () => setStatus('connected'));
    instance.on('disconnect', () => setStatus('disconnected'));
    instance.io.on('reconnect_attempt', () => setStatus('connecting'));

    /*
     * Access tokens live 15 minutes, so a long-lived socket outlasts the token
     * it handshook with. Re-authenticating on every rotation means a reconnect
     * after an idle period presents a token the server will still accept.
     */
    const unsubscribe = session.onTokensChanged(() => {
      const nextToken = session.getAccessToken();
      if (!nextToken) {
        instance.disconnect();
        return;
      }
      instance.auth = { token: nextToken };
      if (!instance.connected) instance.connect();
    });

    return () => {
      unsubscribe();
      instance.removeAllListeners();
      instance.disconnect();
      setSocket(null);
      setStatus('idle');
    };
  }, [authStatus]);

  const value = useMemo<SocketContextValue>(() => ({ socket, status }), [socket, status]);

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  const context = useContext(SocketContext);
  if (!context) throw new Error('useSocket must be used inside <SocketProvider>.');
  return context;
}

/**
 * Subscribes to one server event for the lifetime of the calling component.
 *
 * The handler is held in a ref so a caller can pass an inline arrow function
 * without tearing the listener down and rebuilding it on every render — the
 * usual way live updates end up silently missing events.
 */
export function useSocketEvent<TPayload = Record<string, unknown>>(
  event: SocketEventName,
  handler: (payload: TPayload) => void,
): void {
  const { socket } = useSocket();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  const listener = useCallback((payload: TPayload) => handlerRef.current(payload), []);

  useEffect(() => {
    if (!socket) return undefined;
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [socket, event, listener]);
}

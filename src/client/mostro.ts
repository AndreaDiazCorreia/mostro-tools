import { EventEmitter } from 'tseep';
import { NDKEvent, NDKSubscription } from '@nostr-dev-kit/ndk';
import { Nostr, OrderFilters } from '../utils/nostr';
import { Action, NewOrder, Order, MostroInfo, MostroMessage, OrderStatus } from '../types/core';
import { extractOrderFromEvent, prepareNewOrder } from '../core/order';
import { KeyManager } from '../utils/key-manager';

const DEFAULT_RELAYS = ['wss://nostr.orangepill.dev', 'wss://relay.orangepill.dev', 'wss://nostr.zebedee.cloud'];
const REQUEST_TIMEOUT = 10000; // 10 seconds

interface PendingRequest {
  resolve: (value: MostroMessage) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}

type MostroEvents = {
  'order-update': (order: Order, event: NDKEvent) => void;
  'mostro-info': (info: MostroInfo) => void;
  dm: (message: MostroMessage, sender: string) => void;
  // Allow dynamic event names for action-orderId
  [key: string]: (...args: any[]) => void;
};

export interface MostroOptions {
  mostroPubKey?: string;
  relays: string[];
  privateKey?: string;
  debug?: boolean;
}

export interface OrderSearchOptions {
  /** Authors to filter by (public keys) */
  authors?: string[];
  /** Type of order (buy/sell) */
  orderType?: string;
  /** Currency code (e.g., 'USD', 'VES') */
  currency?: string;
  /** Status of the order */
  status?: OrderStatus;
  /** Platform identifier */
  platform?: string;
  /** Payment methods to filter by */
  paymentMethods?: string[];
  /** Document type (usually 'order' for P2P orders) */
  documentType?: string;
}

export enum PublicKeyType {
  HEX = 'hex',
  NPUB = 'npub',
}

export class Mostro extends EventEmitter<MostroEvents> {
  private nostr: Nostr;
  private mostroPubKey: string | undefined;
  private keyManager?: KeyManager;
  private activeOrders: Map<string, Order> = new Map();
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private nextRequestId = 0;
  private readyPromise: Promise<void>;
  private customOrderSubscriptions: Map<string, NDKSubscription> = new Map();
  private options: MostroOptions;

  constructor(options: MostroOptions) {
    super();
    this.options = options;
    this.nostr = new Nostr(options.relays, options.debug || false);

    if (options.privateKey) {
      this.keyManager = new KeyManager();
      this.nostr.updatePrivKey(options.privateKey);
    }

    this.mostroPubKey = options.mostroPubKey;

    this.setupEventHandlers();

    // Initialize readyPromise by calling connect immediately
    this.readyPromise = this.connect();
  }

  private setupEventHandlers() {
    this.nostr.on('ready', this.onNostrReady.bind(this));
    this.nostr.on('public-message', this.handlePublicMessage.bind(this));
    this.nostr.on('dm', this.handlePrivateMessage.bind(this));
    // Subscribe to direct messages if private key is available
    if (this.options.privateKey) {
      this.nostr.subscribeDirectMessages();
    }
  }

  private onNostrReady() {
    if (this.options.debug) console.log('Nostr ready');
    // Subscribe to orders only if a mostroPubKey is provided
    if (this.mostroPubKey) {
      this.nostr.subscribeOrders(this.mostroPubKey);
    } else {
      // Perhaps subscribe with general filters if no specific mostro is targeted?
      // Or emit a general 'ready' event for the client to decide?
      this.emit('ready'); // Emit general ready if no Mostro pubkey specified
    }
  }

  async connect(): Promise<void> {
    await this.nostr.connect();
    return this.readyPromise;
  }

  private handlePublicMessage = (event: NDKEvent): void => {
    try {
      if (event.kind === 4) {
        const order = extractOrderFromEvent(event);
        if (order) {
          if (this.options.debug) console.log(`Received order update for ${order.id}:`, order);
          this.emit('order-update', order, event);
        } else {
          // Could be MostroInfo
          const info = this.extractMostroInfoFromEvent(event);
          if (info) {
            if (this.options.debug) console.log('Received Mostro info:', info);
            this.emit('mostro-info', info);
          }
        }
      }
    } catch (error) {
      if (this.options.debug) {
        console.error('Error handling public message:', error);
      }
    }
  };

  private handlePrivateMessage = (sender: string, message: string): void => {
    try {
      const mostroMessage = JSON.parse(message) as MostroMessage;
      if (this.options.debug) console.log(`Received DM from ${sender}:`, mostroMessage);

      // Emit specific events based on message action/id for waitForAction
      if (mostroMessage.order) {
        const orderId = mostroMessage.order.id;
        const action = mostroMessage.order.action;
        if (orderId && action) {
          const eventName = `${action}-${orderId}`;
          // Emit with MostroMessage and sender pubkey
          this.emit(eventName, mostroMessage, sender);
        }
      }
      // Emit general DM event as well
      this.emit('dm', mostroMessage, sender);
    } catch (error) {
      console.error('Error handling private message:', error, 'Original message:', message);
    }
  };

  async submitOrder(newOrder: NewOrder): Promise<MostroMessage> {
    if (!this.keyManager) {
      throw new Error('Key manager not initialized');
    }

    const order = prepareNewOrder(newOrder);
    const [requestId, promise] = this.createPendingRequest();

    const payload = {
      order: {
        version: 1,
        request_id: requestId,
        action: Action.NewOrder,
        content: { order },
      },
    };

    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX));

    return promise;
  }

  async takeSell(order: Order, amount?: number): Promise<MostroMessage> {
    const [requestId, promise] = this.createPendingRequest();

    const payload = {
      order: {
        version: 1,
        request_id: requestId,
        action: Action.TakeSell,
        id: order.id,
        content: amount ? { amount } : null,
      },
    };

    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX));

    return promise;
  }

  async takeBuy(order: Order, amount?: number): Promise<MostroMessage> {
    const [requestId, promise] = this.createPendingRequest();

    const payload = {
      order: {
        version: 1,
        request_id: requestId,
        action: Action.TakeBuy,
        id: order.id,
        content: amount ? { amount } : null,
      },
    };

    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX));

    return promise;
  }

  async addInvoice(order: Order, invoice: string, amount?: number): Promise<MostroMessage> {
    const [requestId, promise] = this.createPendingRequest();

    const payload = {
      order: {
        version: 1,
        request_id: requestId,
        action: Action.AddInvoice,
        id: order.id,
        content: {
          payment_request: [null, invoice, amount],
        },
      },
    };

    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX));

    return promise;
  }

  async release(order: Order): Promise<MostroMessage> {
    const [requestId, promise] = this.createPendingRequest();

    const payload = {
      order: {
        version: 1,
        request_id: requestId,
        action: Action.Release,
        id: order.id,
        content: null,
      },
    };

    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX));

    return promise;
  }

  async fiatSent(order: Order): Promise<MostroMessage> {
    const [requestId, promise] = this.createPendingRequest();

    const payload = {
      order: {
        version: 1,
        request_id: requestId,
        action: Action.FiatSent,
        id: order.id,
        content: null,
      },
    };

    await this.nostr.createAndPublishMostroEvent(payload, this.getMostroPublicKey(PublicKeyType.HEX));

    return promise;
  }

  async getActiveOrders(): Promise<Order[]> {
    return Array.from(this.activeOrders.values());
  }

  async searchOrders(options: OrderSearchOptions): Promise<Order[]> {
    const searchId = `search_${Date.now()}`;

    // Convert options to OrderFilters format, ensuring proper typing
    const filters: OrderFilters = {
      authors: options.authors || undefined,
      orderType: options.orderType || undefined,
      currency: options.currency || undefined,
      status: options.status ? String(options.status) : undefined,
      documentType: 'order', // Always filter for order documents
      platform: options.platform || undefined,
      paymentMethods: options.paymentMethods || undefined,
    };

    return new Promise<Order[]>((resolve) => {
      const orders: Order[] = [];
      const subscription = this.nostr.subscribeOrdersWithFilters(filters);

      // Store the subscription
      this.customOrderSubscriptions.set(searchId, subscription);

      // Set timeout for search (default to 5 seconds)
      setTimeout(() => {
        this.closeOrderSearch(searchId);
        resolve(orders);
      }, 5000);

      // Listen for events
      const handler = (event: NDKEvent) => {
        const order = extractOrderFromEvent(event);
        if (order) {
          orders.push(order);
        }
      };

      subscription.on('event', handler);
    });
  }

  private closeOrderSearch(searchId: string): void {
    const subscription = this.customOrderSubscriptions.get(searchId);
    if (subscription) {
      subscription.stop();
      this.customOrderSubscriptions.delete(searchId);
    }
  }

  async searchBuyOrders(options: Omit<OrderSearchOptions, 'orderType'> = {}): Promise<Order[]> {
    return this.searchOrders({
      ...options,
      orderType: 'buy',
    });
  }

  async searchSellOrders(options: Omit<OrderSearchOptions, 'orderType'> = {}): Promise<Order[]> {
    return this.searchOrders({
      ...options,
      orderType: 'sell',
    });
  }

  async searchOrdersByCurrency(currency: string, options: Omit<OrderSearchOptions, 'currency'> = {}): Promise<Order[]> {
    return this.searchOrders({
      ...options,
      currency,
    });
  }

  async searchOrdersByPaymentMethod(
    paymentMethod: string | string[],
    options: Omit<OrderSearchOptions, 'paymentMethods'> = {},
  ): Promise<Order[]> {
    const paymentMethods = Array.isArray(paymentMethod) ? paymentMethod : [paymentMethod];
    return this.searchOrders({
      ...options,
      paymentMethods,
    });
  }

  async waitForOrderUpdate(orderId: string, timeoutMs: number = REQUEST_TIMEOUT): Promise<Order> {
    return new Promise<Order>((resolve, reject) => {
      const handler = (order: Order, _event: NDKEvent) => {
        if (order.id === orderId) {
          clearTimeout(timer);
          this.off('order-update', handler);
          resolve(order);
        }
      };
      this.on('order-update', handler);

      const timer = setTimeout(() => {
        this.off('order-update', handler);
        reject(new Error(`Timeout waiting for order update on order ${orderId}`));
      }, timeoutMs);
    });
  }

  async waitForAction(action: Action, orderId: string, timeoutMs: number = REQUEST_TIMEOUT): Promise<MostroMessage> {
    return new Promise<MostroMessage>((resolve, reject) => {
      const eventName = `${action}-${orderId}`;
      // Define the handler function
      const handler = (mostroMessage: MostroMessage, _sender: string) => {
        // No need to parse again, already done in handlePrivateMessage
        if (mostroMessage.order?.action === action && mostroMessage.order.id === orderId) {
          clearTimeout(timer);
          this.off(eventName, handler); // Use the specific eventName
          resolve(mostroMessage);
        }
      };
      // Listen on the specific event
      this.on(eventName, handler);

      const timer = setTimeout(() => {
        this.off(eventName, handler);
        reject(new Error(`Timeout waiting for action ${action} on order ${orderId}`));
      }, timeoutMs);
    });
  }

  private createPendingRequest(): [number, Promise<MostroMessage>] {
    const requestId = this.nextRequestId++;
    let resolver: (value: MostroMessage) => void;
    let rejecter: (reason: any) => void;

    const promise = new Promise<MostroMessage>((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });

    const timer = setTimeout(() => {
      this.pendingRequests.delete(requestId);
      rejecter!(new Error('Request timed out'));
    }, REQUEST_TIMEOUT);

    this.pendingRequests.set(requestId, {
      resolve: resolver!,
      reject: rejecter!,
      timer,
    });

    return [requestId, promise];
  }

  private extractMostroInfoFromEvent(ev: NDKEvent): MostroInfo | null {
    try {
      const tags = new Map(ev.tags.map((tag) => [tag[0], tag[1]]));
      return {
        mostro_pubkey: tags.get('mostro_pubkey') || '',
        mostro_version: tags.get('mostro_version') || '',
        mostro_commit_id: tags.get('mostro_commit_id') || '',
        max_order_amount: Number(tags.get('max_order_amount')) || 0,
        min_order_amount: Number(tags.get('min_order_amount')) || 0,
        expiration_hours: Number(tags.get('expiration_hours')) || 24,
        expiration_seconds: Number(tags.get('expiration_seconds')) || 900,
        fee: Number(tags.get('fee')) || 0,
        hold_invoice_expiration_window: Number(tags.get('hold_invoice_expiration_window')) || 120,
        invoice_expiration_window: Number(tags.get('invoice_expiration_window')) || 120,
      };
    } catch (error) {
      if (this.options.debug) {
        console.error('Error extracting info from event:', error);
      }
      return null;
    }
  }

  async submitDirectMessageToPeer(message: string, destination: string, tags: string[][]): Promise<void> {
    await this.nostr.sendDirectMessageToPeer(message, destination, tags);
  }

  getMostroPublicKey(type: PublicKeyType = PublicKeyType.NPUB): string {
    return this.nostr.getMyPubKey(type);
  }

  updatePrivKey(privKey: string): void {
    this.nostr.updatePrivKey(privKey);
    this.keyManager = new KeyManager();
  }

  getNostr(): Nostr {
    return this.nostr;
  }

  disconnect(): void {
    this.nostr.disconnect();
  }
}

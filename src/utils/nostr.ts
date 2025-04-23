import { EventEmitter } from 'tseep';
import { Event as NostrEvent, finalizeEvent, getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { nip44 } from 'nostr-tools';
import NDK, { NDKEvent, NDKFilter, NDKKind, NDKSubscription } from '@nostr-dev-kit/ndk';
import { PublicKeyType } from '../client/mostro';

/**
 * Filters for subscribing to order events
 */
export interface OrderFilters {
  /** Array of author public keys to filter by */
  authors?: string[] | undefined;
  /** Order type: 'buy' or 'sell' */
  orderType?: string | undefined;
  /** Currency code (e.g., 'USD', 'VES') */
  currency?: string | undefined;
  /** Status of the order (e.g., 'pending', 'canceled', 'in-progress', 'success') */
  status?: string | undefined;
  /** Document type (usually 'order' for P2P orders) */
  documentType?: string | undefined;
  /** Platform identifier (e.g., 'mostrop2p', 'lnp2pbot') */
  platform?: string | undefined;
  /** Payment methods to filter by */
  paymentMethods?: string[] | undefined;
}

export const NOSTR_REPLACEABLE_EVENT_KIND = 38383 as NDKKind;
export interface Rumor extends Omit<NostrEvent, 'sig'> {
  id: string;
}

export interface Seal extends NostrEvent {
  kind: 13;
}

export interface GiftWrap extends NostrEvent {
  kind: 1059;
}

export type GiftWrapContent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
};

type NostrEvents = {
  ready: () => void;
  'public-message': (event: NDKEvent) => void;
  dm: (senderPubkey: string, content: string) => void;
};

export class Nostr extends EventEmitter<NostrEvents> {
  private ndk: NDK;
  private subscriptions: Map<string, NDKSubscription> = new Map();
  private initialized: boolean = false;
  private privateKey: Uint8Array | undefined = undefined;

  constructor(
    relays: string[],
    private debug: boolean = false,
  ) {
    super();
    this.ndk = new NDK({
      explicitRelayUrls: relays,
    });

    // Set up NDK event handlers
    this.ndk.pool.on('connect', () => this.emit('ready'));
  }

  async connect(): Promise<void> {
    if (!this.initialized) {
      await this.ndk.connect();
      this.initialized = true;
    }
  }

  subscribeOrders(mostroPubKey: string): NDKSubscription {
    if (!this.initialized) {
      throw new Error('Nostr not initialized');
    }

    const filter: NDKFilter = {
      kinds: [NOSTR_REPLACEABLE_EVENT_KIND as NDKKind],
      authors: [mostroPubKey],
      since: Math.floor(Date.now() / 1000) - 24 * 60 * 60 * 14,
    };

    const subscription = this.ndk.subscribe(filter, { closeOnEose: false });

    subscription.on('event', (event: NDKEvent) => {
      this.emit('public-message', event);
    });

    const subId = `orders-${mostroPubKey}`;
    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  subscribeOrdersWithFilters(filters: OrderFilters): NDKSubscription {
    if (!this.initialized) {
      throw new Error('Nostr not initialized');
    }

    const ndkFilters: NDKFilter = {
      kinds: [NOSTR_REPLACEABLE_EVENT_KIND as NDKKind],
      since: Math.floor(Date.now() / 1000) - 24 * 60 * 60 * 14,
    };

    if (filters.authors && filters.authors.length > 0) {
      ndkFilters.authors = filters.authors;
    }

    const subscription = this.ndk.subscribe(ndkFilters, { closeOnEose: false });

    subscription.on('event', async (event: NDKEvent) => {
      if (!this.isOrderEvent(event, filters)) {
        return;
      }

      this.emit('public-message', event);
    });

    const subId = `filtered-orders-${JSON.stringify(filters)}`;
    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  private isOrderEvent(event: NDKEvent, filters: OrderFilters): boolean {
    const tagMap = new Map<string, string>();
    for (const tag of event.tags) {
      if (tag.length >= 2) {
        tagMap.set(tag[0], tag[1]!);
      }
    }

    // Check document type
    if (filters.documentType !== undefined) {
      const tagValue = tagMap.get('z');
      if (tagValue === undefined || tagValue !== filters.documentType) {
        return false;
      }
    }

    // Check order type (buy/sell)
    if (filters.orderType !== undefined) {
      const tagValue = tagMap.get('k');
      if (tagValue === undefined || tagValue !== filters.orderType) {
        return false;
      }
    }

    // Check currency
    if (filters.currency !== undefined) {
      const tagValue = tagMap.get('f');
      if (tagValue === undefined || tagValue !== filters.currency) {
        return false;
      }
    }

    // Check status
    if (filters.status !== undefined) {
      const tagValue = tagMap.get('s');
      if (tagValue === undefined || tagValue !== filters.status) {
        return false;
      }
    }

    // Check platform
    if (filters.platform !== undefined) {
      const tagValue = tagMap.get('y');
      if (tagValue === undefined || tagValue !== filters.platform) {
        return false;
      }
    }

    // Check payment methods if specified
    if (filters.paymentMethods && filters.paymentMethods.length > 0) {
      const pmTag = tagMap.get('pm');
      if (!pmTag) return false;

      const orderPms = pmTag.split(',').map((pm) => pm.trim().toLowerCase());
      const filterPms = filters.paymentMethods.map((pm) => pm.toLowerCase());

      if (!filterPms.some((pm) => orderPms.includes(pm))) {
        return false;
      }
    }

    return true;
  }

  subscribeDirectMessages(): NDKSubscription {
    if (!this.initialized) {
      throw new Error('Nostr not initialized');
    }
    if (!this.privateKey) {
      throw new Error('Private key not set, cannot subscribe to DMs');
    }

    const myPubKey = getPublicKey(this.privateKey);

    const filter: NDKFilter = {
      kinds: [4 as NDKKind],
      '#p': [myPubKey],
      since: Math.floor(Date.now() / 1000),
    };

    const subscription = this.ndk.subscribe(filter, { closeOnEose: false });

    subscription.on('event', async (event: NDKEvent) => {
      if (event.kind === 4 && event.pubkey !== myPubKey) {
        try {
          const decryptedContent = this.decryptContent(event.content, event.pubkey);
          this.emit('dm', event.pubkey, decryptedContent);
        } catch (error) {
          console.error('Failed to decrypt DM:', error, 'Event ID:', event.id);
        }
      }
    });

    const subId = `dms-${myPubKey}`;
    this.subscriptions.set(subId, subscription);
    if (this.debug) console.log(`Subscribed to DMs for pubkey: ${myPubKey}`);
    return subscription;
  }

  createGiftWrapEvent(content: GiftWrapContent, recipientPublicKey: string): GiftWrap {
    const randomPrivKey = generateSecretKey();
    return finalizeEvent(
      {
        kind: 1059,
        content: this.encryptContent(content, randomPrivKey, recipientPublicKey),
        created_at: this.randomTimestamp(),
        tags: [['p', recipientPublicKey]],
      },
      randomPrivKey,
    ) as GiftWrap;
  }

  private encryptContent(content: object, privateKey: Uint8Array, recipientPublicKey: string): string {
    const conversationKey = nip44.v2.utils.getConversationKey(privateKey, recipientPublicKey);
    return nip44.v2.encrypt(JSON.stringify(content), conversationKey);
  }

  private decryptContent(encryptedContent: string, senderPublicKey: string): string {
    if (!this.privateKey) {
      throw new Error('Private key not set, cannot decrypt content');
    }
    const conversationKey = nip44.v2.utils.getConversationKey(this.privateKey, senderPublicKey);
    return nip44.v2.decrypt(encryptedContent, conversationKey);
  }

  private randomTimestamp(): number {
    const TWO_DAYS = 2 * 24 * 60 * 60;
    return Math.floor(Date.now() / 1000 - Math.random() * TWO_DAYS);
  }

  async publish(event: NostrEvent): Promise<void> {
    if (!this.initialized) {
      throw new Error('Nostr not initialized');
    }
    const ndkEvent = new NDKEvent(this.ndk, event);
    await ndkEvent.publish();
  }

  async createAndPublishMostroEvent(payload: any, recipientPublicKey: string): Promise<void> {
    if (!this.privateKey) {
      throw new Error('Private key not set');
    }

    const content: GiftWrapContent = {
      id: Buffer.from(generateSecretKey()).toString('hex'),
      pubkey: getPublicKey(this.privateKey),
      created_at: this.randomTimestamp(),
      kind: 1,
      tags: [],
      content: JSON.stringify(payload),
    };

    const giftWrap = this.createGiftWrapEvent(content, recipientPublicKey);

    await this.publish(giftWrap);
  }

  async sendDirectMessageToPeer(message: string, destination: string, tags: string[][]): Promise<void> {
    if (!this.privateKey) {
      throw new Error('Private key not set');
    }

    const encryptedMessage = this.encryptContent({ content: message }, this.privateKey, destination);

    const event = finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        content: encryptedMessage,
        tags: [['p', destination], ...tags],
      },
      this.privateKey,
    );

    await this.publish(event);
  }

  updatePrivKey(privKey: string): void {
    if (privKey) {
      try {
        let decodedKey: Uint8Array | undefined = undefined;
        if (privKey.startsWith('nsec')) {
          const decoded = nip19.decode(privKey);
          if (decoded.type === 'nsec') {
            decodedKey = decoded.data;
          } else {
            throw new Error('Invalid nsec key provided');
          }
        } else if (/^[0-9a-fA-F]{64}$/.test(privKey)) {
          decodedKey = Buffer.from(privKey, 'hex');
        } else {
          throw new Error('Invalid private key format. Use hex or nsec.');
        }
        this.privateKey = decodedKey;
        if (this.privateKey && this.debug) console.log('Private key updated.');
      } catch (e) {
        console.error('Error decoding private key:', e);
        this.privateKey = undefined;
      }
    } else {
      this.privateKey = undefined;
    }
  }

  getMyPubKey(type: PublicKeyType = PublicKeyType.NPUB): string {
    if (!this.privateKey) {
      throw new Error('Private key not set');
    }
    const pubkey = getPublicKey(this.privateKey);
    return type === PublicKeyType.NPUB ? nip19.npubEncode(pubkey) : pubkey;
  }

  unsubscribe(subscriptionId: string): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (sub) {
      sub.stop();
      this.subscriptions.delete(subscriptionId);
      if (this.debug) console.log(`Unsubscribed from ${subscriptionId}`);
    }
  }

  unsubscribeAll(): void {
    this.subscriptions.forEach((sub, id) => {
      sub.stop();
      if (this.debug) console.log(`Unsubscribed from ${id}`);
    });
    this.subscriptions.clear();
  }

  disconnect(): void {
    this.unsubscribeAll();
    this.ndk.pool.removeAllListeners();
    this.initialized = false;
    if (this.debug) console.log('NDK disconnected.');
  }
}

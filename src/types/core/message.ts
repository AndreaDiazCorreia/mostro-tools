// src/types/core/message.ts
import type { Order } from './order'

export enum Action {
  // Order actions
  NewOrder = 'new-order',
  TakeSell = 'take-sell',
  TakeBuy = 'take-buy',
  PayInvoice = 'pay-invoice',
  AddInvoice = 'add-invoice',
  FiatSent = 'fiat-sent',
  FiatSentOk = 'fiat-sent-ok',
  Release = 'release',
  Released = 'released',
  Cancel = 'cancel',
  Canceled = 'canceled',

  // Status related
  WaitingBuyerInvoice = 'waiting-buyer-invoice',
  WaitingSellerToPay = 'waiting-seller-to-pay',
  BuyerTookOrder = 'buyer-took-order',
  HoldInvoicePaymentAccepted = 'hold-invoice-payment-accepted',
  HoldInvoicePaymentSettled = 'hold-invoice-payment-settled',
  HoldInvoicePaymentCanceled = 'hold-invoice-payment-canceled',

  // Cooperative cancellation
  CooperativeCancelInitiatedByYou = 'cooperative-cancel-initiated-by-you',
  CooperativeCancelInitiatedByPeer = 'cooperative-cancel-initiated-by-peer',
  CooperativeCancelAccepted = 'cooperative-cancel-accepted',

  // Rating
  Rate = 'rate',
  RateUser = 'rate-user',
  RateReceived = 'rate-received',

  // Dispute
  Dispute = 'dispute',
  DisputeInitiatedByYou = 'dispute-initiated-by-you',
  DisputeInitiatedByPeer = 'dispute-initiated-by-peer',

  // Error states
  CantDo = 'cant-do',
  OutOfRangeFiatAmount = 'out-of-range-fiat-amount',
  IsNotYourDispute = 'is-not-your-dispute',
  NotFound = 'not-found',
  IncorrectInvoiceAmount = 'incorrect-invoice-amount',
  InvalidSatsAmount = 'invalid-sats-amount',
  OutOfRangeSatsAmount = 'out-of-range-sats-amount',
  PaymentFailed = 'payment-failed',
  InvoiceUpdated = 'invoice-updated',
}

export interface MessageContent {
  order?: Order
  payment_request?: [Order | null, string, number?]
  text_message?: string
  peer?: { pubkey: string }
  rating_user?: {
    value: number
    confirmed: boolean
  }
  dispute?: {
    id: string
    buyer_token?: number
    seller_token?: number
  }
}

export interface MessageKind {
  version: number
  request_id: number
  id?: string
  action: Action
  content?: MessageContent
}

export interface Message {
  order?: MessageKind
  dispute?: MessageKind
  cant_do?: MessageKind
  rate?: MessageKind
}

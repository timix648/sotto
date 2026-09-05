// A5 - HCS audit trail.
//
// Every RFQ lifecycle event is timestamped by network consensus. This is what
// makes the venue auditable without being transparent while the auction is live:
// a commit hash is on the ledger, ordered and timestamped, BEFORE any price is
// readable. The audit trail IS the privacy mechanism.
//
// NOTE: HCS is not callable from the EVM. HIP-478 was proposed and never
// shipped - there is no HCS precompile. All writes go through the backend SDK.
// Do not go looking for 0x16c.
import {
  Client, AccountId, PrivateKey, TopicId,
  TopicCreateTransaction, TopicMessageSubmitTransaction,
} from '@hashgraph/sdk';
import type { AuditEvent, AuditKind } from '../../../packages/shared/src/types.js';

export interface HcsConfig {
  operatorId: string;
  operatorKey: string;
  topicId?: string;
}

export class HcsAudit {
  private client: Client;
  private key: PrivateKey;
  private _topicId: TopicId | null = null;

  constructor(cfg: HcsConfig) {
    this.key = PrivateKey.fromStringECDSA(cfg.operatorKey);
    this.client = Client.forTestnet().setOperator(AccountId.fromString(cfg.operatorId), this.key);
    if (cfg.topicId) this._topicId = TopicId.fromString(cfg.topicId);
  }

  get topicId(): string | null {
    return this._topicId ? this._topicId.toString() : null;
  }

  get hashscanUrl(): string | null {
    return this._topicId ? `https://hashscan.io/testnet/topic/${this._topicId.toString()}` : null;
  }

  /** Create the audit topic. Admin + submit key are the operator's, so only the
   *  venue can write - readers still verify ordering and timestamps themselves. */
  async createTopic(memo = 'Sotto RFQ audit trail'): Promise<string> {
    const receipt = await (
      await new TopicCreateTransaction()
        .setTopicMemo(memo)
        .setAdminKey(this.key.publicKey)
        .setSubmitKey(this.key.publicKey)
        .execute(this.client)
    ).getReceipt(this.client);

    if (!receipt.topicId) throw new Error('topic creation returned no topicId');
    this._topicId = receipt.topicId;
    return receipt.topicId.toString();
  }

  /**
   * Submit one audit event and return it with its consensus sequence number and
   * timestamp filled in. Body is {v:1, rfqId, kind, payload, ts}; the SDK chunks
   * anything over 1024 bytes automatically, but we keep payloads small so a
   * single event is a single sequence number.
   */
  async write(rfqId: string, kind: AuditKind, payload: Record<string, unknown> = {}): Promise<AuditEvent> {
    if (!this._topicId) throw new Error('no topic - call createTopic or pass topicId');

    const body = JSON.stringify({ v: 1, rfqId, kind, payload, ts: Math.floor(Date.now() / 1000) });
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > 1024) console.warn(`  [hcs] ${kind} is ${bytes} bytes - will be chunked`);

    // The topic has a submit key, so the message must be signed by it.
    const response = await (
      await new TopicMessageSubmitTransaction()
        .setTopicId(this._topicId)
        .setMessage(body)
        .freezeWith(this.client)
        .sign(this.key)
    ).execute(this.client);

    const receipt = await response.getReceipt(this.client);
    // The receipt carries the sequence number; the consensus timestamp lives on
    // the record, which is a second query but is the value we actually publish.
    const record = await response.getRecord(this.client);

    return {
      rfqId,
      kind,
      payload,
      hcsSequenceNumber: Number(receipt.topicSequenceNumber?.toString() ?? 0),
      consensusTimestamp: record.consensusTimestamp.toString(),
      topicId: this._topicId.toString(),
    };
  }

  close(): void {
    this.client.close();
  }
}

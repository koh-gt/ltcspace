import * as bitcoinjs from 'bitcoinjs-lib';
import { Request } from 'express';
import { Ancestor, CpfpInfo, CpfpSummary, CpfpCluster, EffectiveFeeStats, MempoolBlockWithTransactions, TransactionExtended, MempoolTransactionExtended, TransactionStripped, WorkingEffectiveFeeStats, TransactionClassified, TransactionFlags } from '../mempool.interfaces';
import config from '../config';
import { NodeSocket } from '../repositories/NodesSocketsRepository';
import { isIP } from 'net';
import rbfCache from './rbf-cache';
import transactionUtils from './transaction-utils';
import { isPoint } from '../utils/secp256k1';
export class Common {
  static nativeAssetId = '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d';

  static median(numbers: number[]) {
    let medianNr = 0;
    const numsLen = numbers.length;
    if (numsLen % 2 === 0) {
        medianNr = (numbers[numsLen / 2 - 1] + numbers[numsLen / 2]) / 2;
    } else {
        medianNr = numbers[(numsLen - 1) / 2];
    }
    return medianNr;
  }

  static percentile(numbers: number[], percentile: number) {
    if (percentile === 50) {
      return this.median(numbers);
    }
    const index = Math.ceil(numbers.length * (100 - percentile) * 1e-2);
    if (index < 0 || index > numbers.length - 1) {
      return 0;
    }
    return numbers[index];
  }

  static getFeesInRange(transactions: TransactionExtended[], rangeLength: number) {
    const filtered: TransactionExtended[] = [];
    let lastValidRate = Infinity;
    // filter out anomalous fee rates to ensure monotonic range
    for (const tx of transactions) {
      if (tx.effectiveFeePerVsize <= lastValidRate) {
        filtered.push(tx);
        lastValidRate = tx.effectiveFeePerVsize;
      }
    }
    const arr = [filtered[filtered.length - 1].effectiveFeePerVsize];
    const chunk = 1 / (rangeLength - 1);
    let itemsToAdd = rangeLength - 2;

    while (itemsToAdd > 0) {
      arr.push(filtered[Math.floor(filtered.length * chunk * itemsToAdd)].effectiveFeePerVsize);
      itemsToAdd--;
    }

    arr.push(filtered[0].effectiveFeePerVsize);
    return arr;
  }

  static findRbfTransactions(added: MempoolTransactionExtended[], deleted: MempoolTransactionExtended[], forceScalable = false): { [txid: string]: MempoolTransactionExtended[] } {
    const matches: { [txid: string]: MempoolTransactionExtended[] } = {};

    // For small N, a naive nested loop is extremely fast, but it doesn't scale
    if (added.length < 1000 && deleted.length < 50 && !forceScalable) {
      added.forEach((addedTx) => {
        const foundMatches = deleted.filter((deletedTx) => {
          // The new tx must, absolutely speaking, pay at least as much fee as the replaced tx.
          return addedTx.fee > deletedTx.fee
            // The new transaction must pay more fee per kB than the replaced tx.
            && addedTx.adjustedFeePerVsize > deletedTx.adjustedFeePerVsize
            // Spends one or more of the same inputs
            && deletedTx.vin.some((deletedVin) =>
              addedTx.vin.some((vin) => vin.txid === deletedVin.txid && vin.vout === deletedVin.vout));
            });
        if (foundMatches?.length) {
          matches[addedTx.txid] = [...new Set(foundMatches)];
        }
      });
    } else {
      // for large N, build a lookup table of prevouts we can check in ~constant time
      const deletedSpendMap: { [txid: string]: { [vout: number]: MempoolTransactionExtended } } = {};
      for (const tx of deleted) {
        for (const vin of tx.vin) {
          if (!deletedSpendMap[vin.txid]) {
            deletedSpendMap[vin.txid] = {};
          }
          deletedSpendMap[vin.txid][vin.vout] = tx;
        }
      }

      for (const addedTx of added) {
        const foundMatches = new Set<MempoolTransactionExtended>();
        for (const vin of addedTx.vin) {
          const deletedTx = deletedSpendMap[vin.txid]?.[vin.vout];
          if (deletedTx && deletedTx.txid !== addedTx.txid
              // The new tx must, absolutely speaking, pay at least as much fee as the replaced tx.
              && addedTx.fee > deletedTx.fee
              // The new transaction must pay more fee per kB than the replaced tx.
              && addedTx.adjustedFeePerVsize > deletedTx.adjustedFeePerVsize
          ) {
            foundMatches.add(deletedTx);
          }
          if (foundMatches.size) {
            matches[addedTx.txid] = [...foundMatches];
          }
        }
      }
    }

    return matches;
  }

  static findMinedRbfTransactions(minedTransactions: TransactionExtended[], spendMap: Map<string, MempoolTransactionExtended>): { [txid: string]: { replaced: MempoolTransactionExtended[], replacedBy: TransactionExtended }} {
    const matches: { [txid: string]: { replaced: MempoolTransactionExtended[], replacedBy: TransactionExtended }} = {};
    for (const tx of minedTransactions) {
      const replaced: Set<MempoolTransactionExtended> = new Set();
      for (let i = 0; i < tx.vin.length; i++) {
        const vin = tx.vin[i];
        const match = spendMap.get(`${vin.txid}:${vin.vout}`);
        if (match && match.txid !== tx.txid) {
          replaced.add(match);
          // remove this tx from the spendMap
          // prevents the same tx being replaced more than once
          for (const replacedVin of match.vin) {
            const key = `${replacedVin.txid}:${replacedVin.vout}`;
            spendMap.delete(key);
          }
        }
        const key = `${vin.txid}:${vin.vout}`;
        spendMap.delete(key);
      }
      if (replaced.size) {
        matches[tx.txid] = { replaced: Array.from(replaced), replacedBy: tx };
      }
    }
    return matches;
  }

  static setSchnorrSighashFlags(flags: bigint, witness: string[]): bigint {
    // no witness items
    if (!witness?.length) {
      return flags;
    }
    const hasAnnex = witness.length > 1 && witness[witness.length - 1].startsWith('50');
    if (witness?.length === (hasAnnex ? 2 : 1)) {
      // keypath spend, signature is the only witness item
      if (witness[0].length === 130) {
        flags |= this.setSighashFlags(flags, witness[0]);
      } else {
        flags |= TransactionFlags.sighash_default;
      }
    } else {
      // scriptpath spend, all items except for the script, control block and annex could be signatures
      for (let i = 0; i < witness.length - (hasAnnex ? 3 : 2); i++) {
        // handle probable signatures
        if (witness[i].length === 130) {
          flags |= this.setSighashFlags(flags, witness[i]);
        } else if (witness[i].length === 128) {
          flags |= TransactionFlags.sighash_default;
        }
      }
    }
    return flags;
  }

  static isDERSig(w: string): boolean {
    // heuristic to detect probable DER signatures
    return (w.length >= 18
      && w.startsWith('30') // minimum DER signature length is 8 bytes + sighash flag (see https://mempool.space/testnet/tx/c6c232a36395fa338da458b86ff1327395a9afc28c5d2daa4273e410089fd433)
      && ['01', '02', '03', '81', '82', '83'].includes(w.slice(-2)) // signature must end with a valid sighash flag
      && (w.length === (2 * parseInt(w.slice(2, 4), 16)) + 6) // second byte encodes the combined length of the R and S components
    );
  }

  static setSegwitSighashFlags(flags: bigint, witness: string[]): bigint {
    for (const w of witness) {
      if (this.isDERSig(w)) {
        flags |= this.setSighashFlags(flags, w);
      }
    }
    return flags;
  }

  static setLegacySighashFlags(flags: bigint, scriptsig_asm: string): bigint {
    for (const item of scriptsig_asm.split(' ')) {
      // skip op_codes
      if (item.startsWith('OP_')) {
        continue;
      }
      // check pushed data
      if (this.isDERSig(item)) {
        flags |= this.setSighashFlags(flags, item);
      }
    }
    return flags;
  }

  static setSighashFlags(flags: bigint, signature: string): bigint {
    switch(signature.slice(-2)) {
      case '01': return flags | TransactionFlags.sighash_all;
      case '02': return flags | TransactionFlags.sighash_none;
      case '03': return flags | TransactionFlags.sighash_single;
      case '81': return flags | TransactionFlags.sighash_all | TransactionFlags.sighash_acp;
      case '82': return flags | TransactionFlags.sighash_none | TransactionFlags.sighash_acp;
      case '83': return flags | TransactionFlags.sighash_single | TransactionFlags.sighash_acp;
      default: return flags | TransactionFlags.sighash_default; // taproot only
    }
  }

  static isBurnKey(pubkey: string): boolean {
    return [
      '022222222222222222222222222222222222222222222222222222222222222222',
      '033333333333333333333333333333333333333333333333333333333333333333',
      '020202020202020202020202020202020202020202020202020202020202020202',
      '030303030303030303030303030303030303030303030303030303030303030303',
    ].includes(pubkey);
  }

  static getTransactionFlags(tx: TransactionExtended): number {
    let flags = tx.flags ? BigInt(tx.flags) : 0n;

    // Update variable flags (CPFP, RBF)
    if (tx.ancestors?.length) {
      flags |= TransactionFlags.cpfp_child;
    }
    if (tx.descendants?.length) {
      flags |= TransactionFlags.cpfp_parent;
    }
    if (tx.replacement) {
      flags |= TransactionFlags.replacement;
    }

    // Already processed static flags, no need to do it again
    if (tx.flags) {
      return Number(flags);
    }

    // Process static flags
    if (tx.version === 1) {
      flags |= TransactionFlags.v1;
    } else if (tx.version === 2) {
      flags |= TransactionFlags.v2;
    }
    const reusedAddresses: { [address: string ]: number } = {};
    const inValues = {};
    const outValues = {};
    let rbf = false;
    for (const vin of tx.vin) {
      if (vin.sequence < 0xfffffffe) {
        rbf = true;
      }
      switch (vin.prevout?.scriptpubkey_type) {
        case 'p2pk': flags |= TransactionFlags.p2pk; break;
        case 'multisig': flags |= TransactionFlags.p2ms; break;
        case 'p2pkh': flags |= TransactionFlags.p2pkh; break;
        case 'p2sh': flags |= TransactionFlags.p2sh; break;
        case 'v0_p2wpkh': flags |= TransactionFlags.p2wpkh; break;
        case 'v0_p2wsh': flags |= TransactionFlags.p2wsh; break;
        case 'v1_p2tr': {
          flags |= TransactionFlags.p2tr;
          if (vin.witness.length > 2) {
            const asm = vin.inner_witnessscript_asm || transactionUtils.convertScriptSigAsm(vin.witness[vin.witness.length - 2]);
            if (asm?.includes('OP_0 OP_IF')) {
              flags |= TransactionFlags.inscription;
            }
          }
        } break;
      }

      // sighash flags
      if (vin.prevout?.scriptpubkey_type === 'v1_p2tr') {
        flags |= this.setSchnorrSighashFlags(flags, vin.witness);
      } else if (vin.witness) {
        flags |= this.setSegwitSighashFlags(flags, vin.witness);
      } else if (vin.scriptsig?.length) {
        flags |= this.setLegacySighashFlags(flags, vin.scriptsig_asm || transactionUtils.convertScriptSigAsm(vin.scriptsig));
      }

      if (vin.prevout?.scriptpubkey_address) {
        reusedAddresses[vin.prevout?.scriptpubkey_address] = (reusedAddresses[vin.prevout?.scriptpubkey_address] || 0) + 1;
      }
      inValues[vin.prevout?.value || Math.random()] = (inValues[vin.prevout?.value || Math.random()] || 0) + 1;
    }
    if (rbf) {
      flags |= TransactionFlags.rbf;
    } else {
      flags |= TransactionFlags.no_rbf;
    }
    let hasFakePubkey = false;
    for (const vout of tx.vout) {
      switch (vout.scriptpubkey_type) {
        case 'p2pk': {
          flags |= TransactionFlags.p2pk;
          // detect fake pubkey (i.e. not a valid DER point on the secp256k1 curve)
          hasFakePubkey = hasFakePubkey || !isPoint(vout.scriptpubkey.slice(2, -2));
        } break;
        case 'multisig': {
          flags |= TransactionFlags.p2ms;
          // detect fake pubkeys (i.e. not valid DER points on the secp256k1 curve)
          const asm = vout.scriptpubkey_asm || transactionUtils.convertScriptSigAsm(vout.scriptpubkey);
          for (const key of (asm?.split(' ') || [])) {
            if (!hasFakePubkey && !key.startsWith('OP_')) {
              hasFakePubkey = hasFakePubkey || this.isBurnKey(key) || !isPoint(key);
            }
          }
        } break;
        case 'p2pkh': flags |= TransactionFlags.p2pkh; break;
        case 'p2sh': flags |= TransactionFlags.p2sh; break;
        case 'v0_p2wpkh': flags |= TransactionFlags.p2wpkh; break;
        case 'v0_p2wsh': flags |= TransactionFlags.p2wsh; break;
        case 'v1_p2tr': flags |= TransactionFlags.p2tr; break;
        case 'op_return': flags |= TransactionFlags.op_return; break;
      }
      if (vout.scriptpubkey_address) {
        reusedAddresses[vout.scriptpubkey_address] = (reusedAddresses[vout.scriptpubkey_address] || 0) + 1;
      }
      outValues[vout.value || Math.random()] = (outValues[vout.value || Math.random()] || 0) + 1;
    }
    if (hasFakePubkey) {
      flags |= TransactionFlags.fake_pubkey;
    }

    // fast but bad heuristic to detect possible coinjoins
    // (at least 5 inputs and 5 outputs, less than half of which are unique amounts, with no address reuse)
    const addressReuse = Object.values(reusedAddresses).reduce((acc, count) => Math.max(acc, count), 0) > 1;
    if (!addressReuse && tx.vin.length >= 5 && tx.vout.length >= 5 && (Object.keys(inValues).length + Object.keys(outValues).length) <= (tx.vin.length + tx.vout.length) / 2 ) {
      flags |= TransactionFlags.coinjoin;
    }
    // more than 5:1 input:output ratio
    if (tx.vin.length / tx.vout.length >= 5) {
      flags |= TransactionFlags.consolidation;
    }
    // less than 1:5 input:output ratio
    if (tx.vin.length / tx.vout.length <= 0.2) {
      flags |= TransactionFlags.batch_payout;
    }

    return Number(flags);
  }

  static classifyTransaction(tx: TransactionExtended): TransactionClassified {
    const flags = this.getTransactionFlags(tx);
    tx.flags = flags;
    return {
      ...this.stripTransaction(tx),
      flags,
    };
  }

  static stripTransaction(tx: TransactionExtended): TransactionStripped {
    return {
      txid: tx.txid,
      fee: tx.fee || 0,
      vsize: tx.weight / 4,
      value: tx.vout.reduce((acc, vout) => acc + (vout.value ? vout.value : 0), 0),
      acc: tx.acceleration || undefined,
      rate: tx.effectiveFeePerVsize,
    };
  }

  static stripTransactions(txs: TransactionExtended[]): TransactionStripped[] {
    return txs.map(this.stripTransaction);
  }

  static sleep$(ms: number): Promise<void> {
    return new Promise((resolve) => {
       setTimeout(() => {
         resolve();
       }, ms);
    });
  }

  static shuffleArray(array: any[]) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
  }

  static setRelativesAndGetCpfpInfo(tx: MempoolTransactionExtended, memPool: { [txid: string]: MempoolTransactionExtended }): CpfpInfo {
    const parents = this.findAllParents(tx, memPool);
    const lowerFeeParents = parents.filter((parent) => parent.adjustedFeePerVsize < tx.effectiveFeePerVsize);

    let totalWeight = (tx.adjustedVsize * 4) + lowerFeeParents.reduce((prev, val) => prev + (val.adjustedVsize * 4), 0);
    let totalFees = tx.fee + lowerFeeParents.reduce((prev, val) => prev + val.fee, 0);

    tx.ancestors = parents
      .map((t) => {
        return {
          txid: t.txid,
          weight: (t.adjustedVsize * 4),
          fee: t.fee,
        };
      });

    // Add high (high fee) decendant weight and fees
    if (tx.bestDescendant) {
      totalWeight += tx.bestDescendant.weight;
      totalFees += tx.bestDescendant.fee;
    }

    tx.effectiveFeePerVsize = Math.max(0, totalFees / (totalWeight / 4));
    tx.cpfpChecked = true;

    return {
      ancestors: tx.ancestors,
      bestDescendant: tx.bestDescendant || null,
    };
  }


  private static findAllParents(tx: MempoolTransactionExtended, memPool: { [txid: string]: MempoolTransactionExtended }): MempoolTransactionExtended[] {
    let parents: MempoolTransactionExtended[] = [];
    tx.vin.forEach((parent) => {
      if (parents.find((p) => p.txid === parent.txid)) {
        return;
      }

      const parentTx = memPool[parent.txid];
      if (parentTx) {
        if (tx.bestDescendant && tx.bestDescendant.fee / (tx.bestDescendant.weight / 4) > parentTx.adjustedFeePerVsize) {
          if (parentTx.bestDescendant && parentTx.bestDescendant.fee < tx.fee + tx.bestDescendant.fee) {
            parentTx.bestDescendant = {
              weight: (tx.adjustedVsize * 4) + tx.bestDescendant.weight,
              fee: tx.fee + tx.bestDescendant.fee,
              txid: tx.txid,
            };
          }
        } else if (tx.adjustedFeePerVsize > parentTx.adjustedFeePerVsize) {
          parentTx.bestDescendant = {
            weight: (tx.adjustedVsize * 4),
            fee: tx.fee,
            txid: tx.txid
          };
        }
        parents.push(parentTx);
        parents = parents.concat(this.findAllParents(parentTx, memPool));
      }
    });
    return parents;
  }

  // calculates the ratio of matched transactions to projected transactions by weight
  static getSimilarity(projectedBlock: MempoolBlockWithTransactions, transactions: TransactionExtended[]): number {
    let matchedWeight = 0;
    let projectedWeight = 0;
    const inBlock = {};

    for (const tx of transactions) {
      inBlock[tx.txid] = tx;
    }

    // look for transactions that were expected in the template, but missing from the mined block
    for (const tx of projectedBlock.transactions) {
      if (inBlock[tx.txid]) {
        matchedWeight += tx.vsize * 4;
      }
      projectedWeight += tx.vsize * 4;
    }

    projectedWeight += transactions[0].weight;
    matchedWeight += transactions[0].weight;

    return projectedWeight ? matchedWeight / projectedWeight : 1;
  }

  static getSqlInterval(interval: string | null): string | null {
    switch (interval) {
      case '24h': return '1 DAY';
      case '3d': return '3 DAY';
      case '1w': return '1 WEEK';
      case '1m': return '1 MONTH';
      case '3m': return '3 MONTH';
      case '6m': return '6 MONTH';
      case '1y': return '1 YEAR';
      case '2y': return '2 YEAR';
      case '3y': return '3 YEAR';
      case '4y': return '4 YEAR';
      default: return null;
    }
  }

  static indexingEnabled(): boolean {
    return (
      ['mainnet', 'testnet'].includes(config.MEMPOOL.NETWORK) &&
      config.DATABASE.ENABLED === true &&
      config.MEMPOOL.INDEXING_BLOCKS_AMOUNT !== 0
    );
  }

  static blocksSummariesIndexingEnabled(): boolean {
    return (
      Common.indexingEnabled() &&
      config.MEMPOOL.BLOCKS_SUMMARIES_INDEXING === true
    );
  }

  static cpfpIndexingEnabled(): boolean {
    return (
      Common.indexingEnabled() &&
      config.MEMPOOL.CPFP_INDEXING === true
    );
  }

  static setDateMidnight(date: Date): void {
    date.setUTCHours(0);
    date.setUTCMinutes(0);
    date.setUTCSeconds(0);
    date.setUTCMilliseconds(0);
  }

  static channelShortIdToIntegerId(channelId: string): string {
    if (channelId.indexOf('x') === -1) { // Already an integer id
      return channelId;
    }
    if (channelId.indexOf('/') !== -1) { // Topology import
      channelId = channelId.slice(0, -2);
    }
    const s = channelId.split('x').map(part => BigInt(part));
    return ((s[0] << 40n) | (s[1] << 16n) | s[2]).toString();
  }

  /** Decodes a channel id returned by lnd as uint64 to a short channel id */
  static channelIntegerIdToShortId(id: string): string {
    if (id.indexOf('/') !== -1) {
      id = id.slice(0, -2);
    }

    if (id.indexOf('x') !== -1) { // Already a short id
      return id;
    }

    const n = BigInt(id);
    return [
      n >> 40n, // nth block
      (n >> 16n) & 0xffffffn, // nth tx of the block
      n & 0xffffn // nth output of the tx
    ].join('x');
  }

  static utcDateToMysql(date?: number | null): string | null {
    if (date === null) {
      return null;
    }
    const d = new Date((date || 0) * 1000);
    return d.toISOString().split('T')[0] + ' ' + d.toTimeString().split(' ')[0];
  }

  static findSocketNetwork(addr: string): {network: string | null, url: string} {
    let network: string | null = null;
    let url: string = addr;

    if (config.LIGHTNING.BACKEND === 'cln') {
      url = addr.split('://')[1];
    }

    if (!url) {
      return {
        network: null,
        url: addr,
      };
    }

    if (addr.indexOf('onion') !== -1) {
      if (url.split('.')[0].length >= 56) {
        network = 'torv3';
      } else {
        network = 'torv2';
      }
    } else if (addr.indexOf('i2p') !== -1) {
      network = 'i2p';
    } else if (addr.indexOf('ipv4') !== -1 || (config.LIGHTNING.BACKEND === 'lnd' && isIP(url.split(':')[0]) === 4)) {
      const ipv = isIP(url.split(':')[0]);
      if (ipv === 4) {
        network = 'ipv4';
      } else {
        return {
          network: null,
          url: addr,
        };
      }
    } else if (addr.indexOf('ipv6') !== -1 || (config.LIGHTNING.BACKEND === 'lnd' && url.indexOf(']:'))) {
      url = url.split('[')[1].split(']')[0];
      const ipv = isIP(url);
      if (ipv === 6) {
        const parts = addr.split(':');
        network = 'ipv6';
        url = `[${url}]:${parts[parts.length - 1]}`;
      } else {
        return {
          network: null,
          url: addr,
        };
      }
    } else {
      return {
        network: null,
        url: addr,
      };
    }

    return {
      network: network,
      url: url,
    };
  }

  static formatSocket(publicKey: string, socket: {network: string, addr: string}): NodeSocket {
    if (config.LIGHTNING.BACKEND === 'cln') {
      return {
        publicKey: publicKey,
        network: socket.network,
        addr: socket.addr,
      };
    } else /* if (config.LIGHTNING.BACKEND === 'lnd') */ {
      const formatted = this.findSocketNetwork(socket.addr);
      return {
        publicKey: publicKey,
        network: formatted.network,
        addr: formatted.url,
      };
    }
  }

  static calculateCpfp(height: number, transactions: TransactionExtended[]): CpfpSummary {
    const clusters: CpfpCluster[] = []; // list of all cpfp clusters in this block
    const clusterMap: { [txid: string]: CpfpCluster } = {}; // map transactions to their cpfp cluster
    let clusterTxs: TransactionExtended[] = []; // working list of elements of the current cluster
    let ancestors: { [txid: string]: boolean } = {}; // working set of ancestors of the current cluster root
    const txMap = {};
    // initialize the txMap
    for (const tx of transactions) {
      txMap[tx.txid] = tx;
    }
    // reverse pass to identify CPFP clusters
    for (let i = transactions.length - 1; i >= 0; i--) {
      const tx = transactions[i];
      if (!ancestors[tx.txid]) {
        let totalFee = 0;
        let totalVSize = 0;
        clusterTxs.forEach(tx => {
          totalFee += tx?.fee || 0;
          totalVSize += (tx.weight / 4);
        });
        const effectiveFeePerVsize = totalFee / totalVSize;
        let cluster: CpfpCluster;
        if (clusterTxs.length > 1) {
          cluster = {
            root: clusterTxs[0].txid,
            height,
            txs: clusterTxs.map(tx => { return { txid: tx.txid, weight: tx.weight, fee: tx.fee || 0 }; }),
            effectiveFeePerVsize,
          };
          clusters.push(cluster);
        }
        clusterTxs.forEach(tx => {
          txMap[tx.txid].effectiveFeePerVsize = effectiveFeePerVsize;
          if (cluster) {
            clusterMap[tx.txid] = cluster;
          }
        });
        // reset working vars
        clusterTxs = [];
        ancestors = {};
      }
      clusterTxs.push(tx);
      tx.vin.forEach(vin => {
        ancestors[vin.txid] = true;
      });
    }
    // forward pass to enforce ancestor rate caps
    for (const tx of transactions) {
      let minAncestorRate = tx.effectiveFeePerVsize;
      for (const vin of tx.vin) {
        if (txMap[vin.txid]?.effectiveFeePerVsize) {
          minAncestorRate = Math.min(minAncestorRate, txMap[vin.txid].effectiveFeePerVsize);
        }
      }
      // check rounded values to skip cases with almost identical fees
      const roundedMinAncestorRate = Math.ceil(minAncestorRate);
      const roundedEffectiveFeeRate = Math.floor(tx.effectiveFeePerVsize);
      if (roundedMinAncestorRate < roundedEffectiveFeeRate) {
        tx.effectiveFeePerVsize = minAncestorRate;
        if (!clusterMap[tx.txid]) {
          // add a single-tx cluster to record the dependent rate
          const cluster = {
            root: tx.txid,
            height,
            txs: [{ txid: tx.txid, weight: tx.weight, fee: tx.fee || 0 }],
            effectiveFeePerVsize: minAncestorRate,
          };
          clusterMap[tx.txid] = cluster;
          clusters.push(cluster);
        } else {
          // update the existing cluster with the dependent rate
          clusterMap[tx.txid].effectiveFeePerVsize = minAncestorRate;
        }
      }
    }
    return {
      transactions,
      clusters,
    };
  }

  static calcEffectiveFeeStatistics(transactions: { weight: number, fee: number, effectiveFeePerVsize?: number, txid: string, acceleration?: boolean }[]): EffectiveFeeStats {
    const sortedTxs = transactions.map(tx => { return { txid: tx.txid, weight: tx.weight, rate: tx.effectiveFeePerVsize || ((tx.fee || 0) / (tx.weight / 4)) }; }).sort((a, b) => a.rate - b.rate);

    let weightCount = 0;
    let medianFee = 0;
    let medianWeight = 0;

    // calculate the "medianFee" as the average fee rate of the middle 10000 weight units of transactions
    const leftBound = 1995000;
    const rightBound = 2005000;
    for (let i = 0; i < sortedTxs.length && weightCount < rightBound; i++) {
      const left = weightCount;
      const right = weightCount + sortedTxs[i].weight;
      if (right > leftBound) {
        const weight = Math.min(right, rightBound) - Math.max(left, leftBound);
        medianFee += (sortedTxs[i].rate * (weight / 4) );
        medianWeight += weight;
      }
      weightCount += sortedTxs[i].weight;
    }
    const medianFeeRate = medianWeight ? (medianFee / (medianWeight / 4)) : 0;

    // minimum effective fee heuristic:
    // lowest of
    // a) the 1st percentile of effective fee rates
    // b) the minimum effective fee rate in the last 2% of transactions (in block order)
    const minFee = Math.min(
      Common.getNthPercentile(1, sortedTxs).rate,
      transactions.slice(-transactions.length / 50).reduce((min, tx) => { return Math.min(min, tx.effectiveFeePerVsize || ((tx.fee || 0) / (tx.weight / 4))); }, Infinity)
    );

    // maximum effective fee heuristic:
    // highest of
    // a) the 99th percentile of effective fee rates
    // b) the maximum effective fee rate in the first 2% of transactions (in block order)
    const maxFee = Math.max(
      Common.getNthPercentile(99, sortedTxs).rate,
      transactions.slice(0, transactions.length / 50).reduce((max, tx) => { return Math.max(max, tx.effectiveFeePerVsize || ((tx.fee || 0) / (tx.weight / 4))); }, 0)
    );

    return {
      medianFee: medianFeeRate,
      feeRange: [
        minFee,
        [10,25,50,75,90].map(n => Common.getNthPercentile(n, sortedTxs).rate),
        maxFee,
      ].flat(),
    };
  }

  static getNthPercentile(n: number, sortedDistribution: any[]): any {
    return sortedDistribution[Math.floor((sortedDistribution.length - 1) * (n / 100))];
  }

  static getTransactionFromRequest(req: Request, form: boolean): string {
    let rawTx: any = typeof req.body === 'object' && form
      ? Object.values(req.body)[0] as any
      : req.body;
    if (typeof rawTx !== 'string') {
      throw Object.assign(new Error('Non-string request body'), { code: -1 });
    }

    // Support both upper and lower case hex
    // Support both txHash= Form and direct API POST
    const reg = form ? /^txHash=((?:[a-fA-F0-9]{2})+)$/ : /^((?:[a-fA-F0-9]{2})+)$/;
    const matches = reg.exec(rawTx);
    if (!matches || !matches[1]) {
      throw Object.assign(new Error('Non-hex request body'), { code: -2 });
    }

    // Guaranteed to be a hex string of multiple of 2
    // Guaranteed to be lower case
    // Guaranteed to pass validation (see function below)
    return this.validateTransactionHex(matches[1].toLowerCase());
  }

  private static validateTransactionHex(txhex: string): string {
    // Do not mutate txhex

    // We assume txhex to be valid hex (output of getTransactionFromRequest above)

    // Check 1: Valid transaction parse
    let tx: bitcoinjs.Transaction;
    try {
      tx = bitcoinjs.Transaction.fromHex(txhex);
    } catch(e) {
      throw Object.assign(new Error('Invalid transaction (could not parse)'), { code: -4 });
    }

    // Check 2: Simple size check
    if (tx.weight() > config.MEMPOOL.MAX_PUSH_TX_SIZE_WEIGHT) {
      throw Object.assign(new Error(`Transaction too large (max ${config.MEMPOOL.MAX_PUSH_TX_SIZE_WEIGHT} weight units)`), { code: -3 });
    }

    // Check 3: Check unreachable script in taproot (if not allowed)
    if (!config.MEMPOOL.ALLOW_UNREACHABLE) {
      tx.ins.forEach(input => {
        const witness = input.witness;
        // See BIP 341: Script validation rules
        const hasAnnex = witness.length >= 2 &&
          witness[witness.length - 1][0] === 0x50;
        const scriptSpendMinLength = hasAnnex ? 3 : 2;
        const maybeScriptSpend = witness.length >= scriptSpendMinLength;

        if (maybeScriptSpend) {
          const controlBlock = witness[witness.length - scriptSpendMinLength + 1];
          if (controlBlock.length === 0 || !this.isValidLeafVersion(controlBlock[0])) {
            // Skip this input, it's not taproot
            return;
          }
          // Definitely taproot. Get script
          const script = witness[witness.length - scriptSpendMinLength];
          const decompiled = bitcoinjs.script.decompile(script);
          if (!decompiled || decompiled.length < 2) {
            // Skip this input
            return;
          }
          // Iterate up to second last (will look ahead 1 item)
          for (let i = 0; i < decompiled.length - 1; i++) {
            const first = decompiled[i];
            const second = decompiled[i + 1];
            if (
              first === bitcoinjs.opcodes.OP_FALSE &&
              second === bitcoinjs.opcodes.OP_IF
            ) {
              throw Object.assign(new Error('Unreachable taproot scripts not allowed'), { code: -5 });
            }
          }
        }
      })
    }

    // Pass through the input string untouched
    return txhex;
  }

  private static isValidLeafVersion(leafVersion: number): boolean {
    // See Note 7 in BIP341
    // https://github.com/bitcoin/bips/blob/66a1a8151021913047934ebab3f8883f2f8ca75b/bip-0341.mediawiki#cite_note-7
    // "What constraints are there on the leaf version?"

    // Must be an integer between 0 and 255
    // Since we're parsing a byte
    if (Math.floor(leafVersion) !== leafVersion || leafVersion < 0 || leafVersion > 255) {
      return false;
    }
    // "the leaf version cannot be odd"
    if ((leafVersion & 0x01) === 1) {
      return false;
    }
    // "The values that comply to this rule are
    // the 32 even values between 0xc0 and 0xfe
    if (leafVersion >= 0xc0 && leafVersion <= 0xfe) {
      return true;
    }
    // and also 0x66, 0x7e, 0x80, 0x84, 0x96, 0x98, 0xba, 0xbc, 0xbe."
    if ([0x66, 0x7e, 0x80, 0x84, 0x96, 0x98, 0xba, 0xbc, 0xbe].includes(leafVersion)) {
      return true;
    }
    // Otherwise, invalid
    return false;
  }
}

/**
 * Class to calculate average fee rates of a list of transactions
 * at certain weight percentiles, in a single pass
 *
 * init with:
 *   maxWeight - the total weight to measure percentiles relative to (e.g. 4MW for a single block)
 *   percentileBandWidth - how many weight units to average over for each percentile (as a % of maxWeight)
 *   percentiles - an array of weight percentiles to compute, in %
 *
 * then call .processNext(tx) for each transaction, in descending order
 *
 * retrieve the final results with .getFeeStats()
 */
export class OnlineFeeStatsCalculator {
  private maxWeight: number;
  private percentiles = [10,25,50,75,90];

  private bandWidthPercent = 2;
  private bandWidth: number = 0;
  private bandIndex = 0;
  private leftBound = 0;
  private rightBound = 0;
  private inBand = false;
  private totalBandFee = 0;
  private totalBandWeight = 0;
  private minBandRate = Infinity;
  private maxBandRate = 0;

  private feeRange: { avg: number, min: number, max: number }[] = [];
  private totalWeight: number = 0;

  constructor (maxWeight: number, percentileBandWidth?: number, percentiles?: number[]) {
    this.maxWeight = maxWeight;
    if (percentiles && percentiles.length) {
      this.percentiles = percentiles;
    }
    if (percentileBandWidth != null) {
      this.bandWidthPercent = percentileBandWidth;
    }
    this.bandWidth = this.maxWeight * (this.bandWidthPercent / 100);
    // add min/max percentiles aligned to the ends of the range
    this.percentiles.unshift(this.bandWidthPercent / 2);
    this.percentiles.push(100 - (this.bandWidthPercent / 2));
    this.setNextBounds();
  }

  processNext(tx: { weight: number, fee: number, effectiveFeePerVsize?: number, feePerVsize?: number, rate?: number, txid: string }): void {
    let left = this.totalWeight;
    const right = this.totalWeight + tx.weight;
    if (!this.inBand && right <= this.leftBound) {
      this.totalWeight += tx.weight;
      return;
    }

    while (left < right) {
      if (right > this.leftBound) {
        this.inBand = true;
        const txRate = (tx.rate || tx.effectiveFeePerVsize || tx.feePerVsize || 0);
        const weight = Math.min(right, this.rightBound) - Math.max(left, this.leftBound);
        this.totalBandFee += (txRate * weight);
        this.totalBandWeight += weight;
        this.maxBandRate = Math.max(this.maxBandRate, txRate);
        this.minBandRate = Math.min(this.minBandRate, txRate);
      }
      left = Math.min(right, this.rightBound);

      if (left >= this.rightBound) {
        this.inBand = false;
        const avgBandFeeRate = this.totalBandWeight ? (this.totalBandFee / this.totalBandWeight) : 0;
        this.feeRange.unshift({ avg: avgBandFeeRate, min: this.minBandRate, max: this.maxBandRate });
        this.bandIndex++;
        this.setNextBounds();
        this.totalBandFee = 0;
        this.totalBandWeight = 0;
        this.minBandRate = Infinity;
        this.maxBandRate = 0;
      }
    }
    this.totalWeight += tx.weight;
  }

  private setNextBounds(): void {
    const nextPercentile = this.percentiles[this.bandIndex];
    if (nextPercentile != null) {
      this.leftBound = ((nextPercentile / 100) * this.maxWeight) - (this.bandWidth / 2);
      this.rightBound = this.leftBound + this.bandWidth;
    } else {
      this.leftBound = Infinity;
      this.rightBound = Infinity;
    }
  }

  getRawFeeStats(): WorkingEffectiveFeeStats {
    if (this.totalBandWeight > 0) {
      const avgBandFeeRate = this.totalBandWeight ? (this.totalBandFee / this.totalBandWeight) : 0;
      this.feeRange.unshift({ avg: avgBandFeeRate, min: this.minBandRate, max: this.maxBandRate });
    }
    while (this.feeRange.length < this.percentiles.length) {
      this.feeRange.unshift({ avg: 0, min: 0, max: 0 });
    }
    return {
      minFee: this.feeRange[0].min,
      medianFee: this.feeRange[Math.floor(this.feeRange.length / 2)].avg,
      maxFee: this.feeRange[this.feeRange.length - 1].max,
      feeRange: this.feeRange.map(f => f.avg),
    };
  }

  getFeeStats(): EffectiveFeeStats {
    const stats = this.getRawFeeStats();
    stats.feeRange[0] = stats.minFee;
    stats.feeRange[stats.feeRange.length - 1] = stats.maxFee;
    return stats;
  }
}

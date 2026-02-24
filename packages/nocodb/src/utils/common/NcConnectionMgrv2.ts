import { Logger } from '@nestjs/common';
import type Source from '~/models/Source';
import {
  defaultConnectionConfig,
  defaultConnectionOptions,
} from '~/utils/nc-config';
import SqlClientFactory from '~/db/sql-client/lib/SqlClientFactory';
import { XKnex } from '~/db/CustomKnex';
import Noco from '~/Noco';

export default class NcConnectionMgrv2 {
  protected static logger = new Logger('NcConnectionMgrv2');

  protected static connectionRefs: {
    [baseId: string]: {
      [sourceId: string]: XKnex;
    };
  } = {};

  public static async destroyAll() {
    for (const baseId in this.connectionRefs) {
      for (const sourceId in this.connectionRefs[baseId]) {
        await this.connectionRefs[baseId][sourceId].destroy();
      }
    }
  }

  public static async deleteAwait(source: Source) {
    // todo: ignore meta bases
    if (this.connectionRefs?.[source.base_id]?.[source.id]) {
      try {
        const conn = this.connectionRefs?.[source.base_id]?.[source.id];
        await conn.destroy();
        delete this.connectionRefs?.[source.base_id][source.id];
      } catch (e) {
        this.logger.error({
          error: e,
          details: 'Error deleting connection ref',
        });
      }
    }
  }

  public static async deleteConnectionRef(sourceId: string) {
    let deleted = false;
    for (const baseId in this.connectionRefs) {
      try {
        if (this.connectionRefs[baseId][sourceId]) {
          await this.connectionRefs[baseId][sourceId].destroy();
          delete this.connectionRefs[baseId][sourceId];
          deleted = true;
        }
      } catch (e) {
        this.logger.error({
          error: e,
          details: 'Error deleting connection ref',
        });
      }
    }
    return deleted;
  }

  public static async get(source: Source): Promise<XKnex> {
    // For NC_MINIMAL_DBS, is_local sources should use their own config, not meta DB
    // Only return meta DB if it's actually a meta source (is_meta=true) or
    // if it's local but NC_MINIMAL_DBS is not enabled
    if (
      source.isMeta(true) ||
      (source.isMeta() &&
        process.env.NC_MINIMAL_DBS !== 'true')
    ) {
      return Noco.ncMeta.knex;
    }

    if (this.connectionRefs?.[source.base_id]?.[source.id]) {
      return this.connectionRefs[source.base_id][source.id];
    }
    this.connectionRefs[source.base_id] =
      this.connectionRefs?.[source.base_id] || {};

    const connectionConfig = await source.getConnectionConfig();

    // Normalize SQLite connection config structure for Knex
    // Handle nested connection.connection.filename from bases.service.ts
    let normalizedConnection = connectionConfig.connection;
    if (connectionConfig.client === 'sqlite3' && normalizedConnection) {
      // Extract filename from nested structure if needed
      // For NC_MINIMAL_DBS, config has structure: connection.connection.filename
      const filename =
        normalizedConnection.filename ||
        normalizedConnection.connection?.filename;
      if (filename) {
        normalizedConnection = {
          filename,
        };
      } else if (normalizedConnection.connection) {
        // If we have nested connection but no filename, try to use the nested connection directly
        // This handles the case where the structure is connection.connection.filename
        normalizedConnection = normalizedConnection.connection;
      }
    }

    this.connectionRefs[source.base_id][source.id] = XKnex({
      ...defaultConnectionOptions,
      ...connectionConfig,
      connection: {
        ...defaultConnectionConfig,
        ...normalizedConnection,
        typeCast(field, next) {
          const res = next();

          // mysql - convert all other buffer values to hex string
          // if `bit` datatype then convert it to integer number
          if (res && res instanceof Buffer) {
            const hex = [...res]
              .map((v) => ('00' + v.toString(16)).slice(-2))
              .join('');
            if (field.type == 'BIT') {
              return parseInt(hex, 16);
            }
            return hex;
          }

          // mysql `decimal` datatype returns value as string, convert it to float number
          if (field.type == 'NEWDECIMAL') {
            return res && parseFloat(res);
          }

          return res;
        },
      },
    } as any);
    return this.connectionRefs[source.base_id][source.id];
  }

  public static async getSqlClient(source: Source, _knex = null) {
    const knex = _knex || (await this.get(source));
    return SqlClientFactory.create({
      knex,
      ...(await source.getConnectionConfig()),
    });
  }

  public static async getDataConfig?() {
    return Noco.getConfig()?.meta?.db;
  }
}

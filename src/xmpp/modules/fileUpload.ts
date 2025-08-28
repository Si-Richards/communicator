/**
 * HTTP File Upload (XEP-0363)
 * Handles file uploads to XMPP server
 */

import { xml } from '@xmpp/client';
import { XmppClient } from '../core/client';
import { XmppEventBus } from '../core/eventBus';
import { XmppUtils } from '../core/utils';
import { logger } from '@/lib/logger';

export interface FileUploadSlot {
  putUrl: string;
  getUrl: string;
  headers?: Record<string, string>;
}

export interface FileUploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

export class FileUploadManager {
  private client: XmppClient;
  private eventBus: XmppEventBus;
  private uploadService?: string;
  private maxFileSize?: number;
  private pendingQueries = new Map<string, (result: any) => void>();

  constructor(client: XmppClient, eventBus: XmppEventBus) {
    this.client = client;
    this.eventBus = eventBus;
  }

  async discoverUploadService(): Promise<string | null> {
    try {
      const config = this.client.getConfig();
      if (!config) return null;

      // Try common upload service domains
      const uploadDomains = [
        `upload.${config.domain}`,
        `http-upload.${config.domain}`,
        `files.${config.domain}`
      ];

      for (const domain of uploadDomains) {
        try {
          const info = await this.queryServiceInfo(domain);
          if (info.features.includes('urn:xmpp:http:upload:0')) {
            this.uploadService = domain;
            
            // Extract max file size if available
            const form = info.form;
            if (form) {
              const maxFileSizeField = form.fields.find((f: any) => f.var === 'max-file-size');
              if (maxFileSizeField && maxFileSizeField.value) {
                this.maxFileSize = parseInt(maxFileSizeField.value, 10);
              }
            }
            
            logger.info('Discovered upload service:', { domain, maxFileSize: this.maxFileSize });
            return domain;
          }
        } catch (error) {
          // Try next domain
          continue;
        }
      }

      logger.warn('No HTTP upload service found');
      return null;
    } catch (error) {
      logger.error('Error discovering upload service:', error);
      return null;
    }
  }

  async uploadFile(
    file: File,
    onProgress?: (progress: FileUploadProgress) => void
  ): Promise<string> {
    if (!this.uploadService) {
      await this.discoverUploadService();
      if (!this.uploadService) {
        throw new Error('No upload service available');
      }
    }

    // Check file size
    if (this.maxFileSize && file.size > this.maxFileSize) {
      throw new Error(`File size ${file.size} exceeds maximum ${this.maxFileSize}`);
    }

    try {
      // Request upload slot
      const slot = await this.requestUploadSlot(file.name, file.size, file.type);
      
      // Upload file
      const uploadedUrl = await this.uploadToSlot(slot, file, onProgress);
      
      logger.info('File uploaded successfully:', uploadedUrl);
      this.eventBus.emit('file:uploaded', { url: uploadedUrl, file });
      
      return uploadedUrl;
    } catch (error) {
      logger.error('File upload failed:', error);
      this.eventBus.emit('file:uploadError', { error, file });
      throw error;
    }
  }

  canHandle(stanza: any): boolean {
    const query = XmppUtils.findChild(stanza, 'query');
    if (!query) return false;
    
    const xmlns = query.attrs?.xmlns;
    return xmlns === 'urn:xmpp:http:upload:0';
  }

  handleStanza(stanza: any): void {
    const id = stanza.attrs.id;
    const type = stanza.attrs.type;
    
    const resolver = this.pendingQueries.get(id);
    if (!resolver) return;
    
    this.pendingQueries.delete(id);

    if (type === 'error') {
      const error = XmppUtils.findChild(stanza, 'error');
      const errorText = error ? XmppUtils.getTextContent(error) : 'Unknown error';
      resolver({ error: errorText });
      return;
    }

    const query = XmppUtils.findChild(stanza, 'slot', 'urn:xmpp:http:upload:0');
    if (query) {
      this.handleSlotResponse(query, resolver);
    }
  }

  cleanup(): void {
    this.pendingQueries.clear();
  }

  private async requestUploadSlot(filename: string, size: number, contentType?: string): Promise<FileUploadSlot> {
    return new Promise((resolve, reject) => {
      const iq = XmppUtils.createIq('get', this.uploadService);
      const request = xml('request', { xmlns: 'urn:xmpp:http:upload:0' });
      request.attrs.filename = filename;
      request.attrs.size = size.toString();
      
      if (contentType) {
        request.attrs['content-type'] = contentType;
      }
      
      iq.cnode(request);

      const queryId = iq.attrs.id;
      
      this.pendingQueries.set(queryId, (result) => {
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });

      // Set timeout
      setTimeout(() => {
        if (this.pendingQueries.has(queryId)) {
          this.pendingQueries.delete(queryId);
          reject(new Error('Upload slot request timeout'));
        }
      }, 10000);

      this.client.send(iq).catch(reject);
    });
  }

  private async uploadToSlot(
    slot: FileUploadSlot, 
    file: File, 
    onProgress?: (progress: FileUploadProgress) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) {
          const progress: FileUploadProgress = {
            loaded: event.loaded,
            total: event.total,
            percentage: Math.round((event.loaded / event.total) * 100)
          };
          onProgress(progress);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(slot.getUrl);
        } else {
          reject(new Error(`Upload failed with status: ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Upload network error'));
      });

      xhr.addEventListener('timeout', () => {
        reject(new Error('Upload timeout'));
      });

      xhr.open('PUT', slot.putUrl);
      
      // Set headers if provided
      if (slot.headers) {
        Object.entries(slot.headers).forEach(([key, value]) => {
          xhr.setRequestHeader(key, value);
        });
      }
      
      // Set content type
      if (file.type) {
        xhr.setRequestHeader('Content-Type', file.type);
      }
      
      xhr.timeout = 30000; // 30 seconds timeout
      xhr.send(file);
    });
  }

  private handleSlotResponse(slot: any, resolver: (result: any) => void): void {
    const put = XmppUtils.findChild(slot, 'put');
    const get = XmppUtils.findChild(slot, 'get');
    
    if (!put || !get) {
      resolver({ error: 'Invalid slot response' });
      return;
    }

    const putUrl = XmppUtils.getAttribute(put, 'url');
    const getUrl = XmppUtils.getAttribute(get, 'url');
    
    if (!putUrl || !getUrl) {
      resolver({ error: 'Missing URLs in slot response' });
      return;
    }

    // Parse headers from put element
    const headers: Record<string, string> = {};
    const headerElements = XmppUtils.findChildren(put, 'header');
    
    for (const header of headerElements) {
      const name = XmppUtils.getAttribute(header, 'name');
      const value = XmppUtils.getTextContent(header);
      if (name && value) {
        headers[name] = value;
      }
    }

    const uploadSlot: FileUploadSlot = {
      putUrl,
      getUrl,
      headers: Object.keys(headers).length > 0 ? headers : undefined
    };

    resolver(uploadSlot);
  }

  private async queryServiceInfo(serviceJid: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const iq = XmppUtils.createIq('get', serviceJid);
      const query = xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' });
      iq.cnode(query);

      const queryId = iq.attrs.id;
      
      this.pendingQueries.set(queryId, (result) => {
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });

      setTimeout(() => {
        if (this.pendingQueries.has(queryId)) {
          this.pendingQueries.delete(queryId);
          reject(new Error('Service info query timeout'));
        }
      }, 5000);

      this.client.send(iq).catch(reject);
    });
  }
}
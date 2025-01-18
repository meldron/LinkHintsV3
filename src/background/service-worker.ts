/// <reference lib="webworker" />

import browser from 'webextension-polyfill';

import { log } from '../shared/main';
import BackgroundProgram from "./Program";

declare const self: ServiceWorkerGlobalScope;


// Initialize the background program
const program = new BackgroundProgram();

// Start the program when the service worker is installed
self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    Promise.all([
      self.skipWaiting(),
      program.start().catch((error) => {
        log("error", "main->BackgroundProgram#start", 'Failed to start background program:', error);
      })
    ])
  );
});

// Ensure the service worker takes control immediately
self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

// Handle runtime messaging errors
browser.runtime.onMessage.addListener((_message, _sender) => {
  const sendResponse = (): void => {
    const {lastError} = browser.runtime;
    if (lastError !== null && lastError !== undefined) {
      const errorMessage = lastError.message;
      if (errorMessage?.includes("back/forward cache") === true) {
        return;
      }
      log("error", "service-worker->onMessage", "Runtime error:", lastError);
    }
  };
  
  try {
    return true;
  } catch (error) {
    log("error", "service-worker->onMessage", "Error handling message:", error);
    return true;
  } finally {
    sendResponse();
  }
});

// Keep the service worker alive for long-running operations
const keepAlive = (): (() => void) => {
  const keepAliveInterval = setInterval(() => {
    void browser.runtime.getPlatformInfo();
  }, 25000);

  return () => {
    clearInterval(keepAliveInterval);
  };
};

const cleanup = keepAlive();

// Cleanup when the service worker is terminated
self.addEventListener('unload', () => {
  cleanup();
  program.stop();
});
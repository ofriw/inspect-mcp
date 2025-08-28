import test from 'node:test';
import assert from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { createMCPClient } from '../helpers/mcp-client.js';
import { createTestServer } from '../helpers/chrome-test-server.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

test('Multiple tabs handling', async (t) => {
    let testServer = null;
    let mcpClient = null;
    let chromeProcess = null;

    try {
        // Kill any existing Chrome on port 9224 and clean user data
        try {
            await execAsync('lsof -ti:9224 | xargs kill -9').catch(() => {});
            await execAsync('rm -rf /tmp/chrome-test-9224').catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            // Ignore cleanup errors
        }
        
        // Start test server
        testServer = await createTestServer();
        const testUrl = testServer.getUrl();
        console.log(`Test page available at: ${testUrl}`);

        // Launch Chrome with multiple tabs
        chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
            '--remote-debugging-port=9224',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1280,1024',
            '--user-data-dir=/tmp/chrome-test-9224',
            testUrl,
            'https://example.com'
        ], { stdio: 'ignore', detached: true });

        // Wait for Chrome to start and CDP to be available
        let cdpReady = false;
        let attempts = 0;
        while (!cdpReady && attempts < 15) {
            try {
                const response = await fetch('http://localhost:9224/json/version');
                cdpReady = response.ok;
                if (cdpReady) {
                    console.log('Chrome CDP ready on port 9224');
                } else {
                    throw new Error('CDP not ready');
                }
            } catch (error) {
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        if (!cdpReady) {
            throw new Error('Chrome failed to start with CDP after 15 seconds');
        }
        
        // Give extra time for both tabs to load their content
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Start MCP server
        const serverPath = join(__dirname, '..', '..', 'dist', 'index.js');
        mcpClient = await createMCPClient(serverPath);

        // Test 1: Try without target_title (should use first tab which lacks our element)
        const noTargetResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '#test-header'
            // No target_title provided - will use first available tab
        });
        
        // Should get an error because first tab (example.com) doesn't have our element
        assert.ok(noTargetResponse.result.isError, 'Should get error when element not found in first tab');
        assert.ok(noTargetResponse.result.content[0].text.includes('Element not found'), 
            'Should get element not found error from wrong tab');
        console.log('✅ Correctly received error for wrong tab:', noTargetResponse.result.content[0].text);

        // Test 2: Use specific target_title to select correct tab
        const inspectionResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '#test-header',
            target_title: 'CDP Inspector Test Page'
        });

        assert.ok(inspectionResponse.result, 'Should successfully inspect with correct target');
        assert.ok(inspectionResponse.result.screenshot, 'Should include screenshot');
        assert.ok(inspectionResponse.result.computed_styles, 'Should include computed styles');

        // Test 3: Try with wrong target_title
        const wrongTargetResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '#test-header',
            target_title: 'Non-existent Page Title'
        });
        
        // Should get an error because target title doesn't exist
        assert.ok(wrongTargetResponse.result.isError, 'Should get error for non-existent target title');
        const errorText = wrongTargetResponse.result.content[0].text;
        assert.ok(errorText.includes('Target not found') || errorText.includes('not found'), 
            'Should get target not found error');
        console.log('✅ Correctly received error for wrong target title:', errorText);

        // Test 4: Try with partial title match
        const partialTitleResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '#test-header',
            target_title: 'Test Page'  // Partial match for "CDP Inspector Test Page"
        });

        assert.ok(partialTitleResponse.result, 'Should work with partial title match');
        console.log('✅ Partial title match works correctly');

        console.log('✅ Multiple tabs test passed');

    } finally {
        // Cleanup
        if (mcpClient) {
            await mcpClient.stop();
        }
        if (testServer) {
            await testServer.stop();
        }
        if (chromeProcess && !chromeProcess.killed) {
            try {
                process.kill(-chromeProcess.pid);
            } catch (error) {
                if (error.code !== 'ESRCH') {
                    console.error('Error killing Chrome process:', error);
                }
            }
        }
        
        // Ensure ALL Chrome processes are killed to prevent test interference
        try {
            await execAsync('pkill -f "Google Chrome"').catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            // Ignore cleanup errors
        }
    }
});
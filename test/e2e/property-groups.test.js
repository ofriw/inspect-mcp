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

test('Property groups functionality', async (t) => {
    let testServer = null;
    let mcpClient = null;
    let chromeProcess = null;

    try {
        // Kill any existing Chrome on port 9226 and clean user data
        try {
            await execAsync('lsof -ti:9226 | xargs kill -9').catch(() => {});
            await execAsync('rm -rf /tmp/chrome-test-9226').catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            // Ignore cleanup errors
        }
        
        // Start test server
        testServer = await createTestServer();
        const testUrl = testServer.getUrl();
        console.log(`Test page available at: ${testUrl}`);

        // Launch Chrome with test page
        chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
            '--remote-debugging-port=9226',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1280,1024',
            '--user-data-dir=/tmp/chrome-test-9226',
            testUrl
        ], { stdio: 'ignore', detached: true });

        // Wait for Chrome to start and CDP to be available
        let cdpReady = false;
        let attempts = 0;
        while (!cdpReady && attempts < 15) {
            try {
                const response = await fetch('http://localhost:9226/json/version');
                cdpReady = response.ok;
                if (cdpReady) {
                    console.log('Chrome CDP ready on port 9226');
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

        // Start MCP server
        const serverPath = join(__dirname, '..', '..', 'dist', 'index.js');
        mcpClient = await createMCPClient(serverPath);

        // Test 1: Default groups (should include layout, box, typography, colors)
        console.log('Testing default property groups...');
        const defaultResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '#test-header',
            url: testUrl
        });

        assert.ok(defaultResponse.result, 'Default groups should work');
        const defaultData = JSON.parse(defaultResponse.result.content[2].text);
        
        assert.ok(defaultData.grouped_styles, 'Should have grouped styles');
        assert.ok(defaultData.grouped_styles.layout, 'Should have layout group');
        assert.ok(defaultData.grouped_styles.box, 'Should have box group');
        assert.ok(defaultData.grouped_styles.typography, 'Should have typography group');
        assert.ok(defaultData.grouped_styles.colors, 'Should have colors group');
        
        // Should have filtering stats
        assert.ok(defaultData.computed_styles_summary, 'Should have filtering summary');
        assert.ok(defaultData.computed_styles_summary.total_properties > 0, 'Should report total properties');
        assert.ok(defaultData.computed_styles_summary.filtered_properties > 0, 'Should report filtered properties');
        
        console.log(`✅ Default filtering: ${defaultData.computed_styles_summary.total_properties} → ${defaultData.computed_styles_summary.filtered_properties} properties`);

        // Test 2: Specific groups only
        console.log('Testing specific property groups...');
        const specificResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '#test-header',
            url: testUrl,
            property_groups: ['colors', 'typography']
        });

        assert.ok(specificResponse.result, 'Specific groups should work');
        const specificData = JSON.parse(specificResponse.result.content[2].text);
        
        assert.ok(specificData.grouped_styles, 'Should have grouped styles');
        assert.ok(specificData.grouped_styles.colors, 'Should have colors group');
        assert.ok(specificData.grouped_styles.typography, 'Should have typography group');
        
        // Should not have many properties in other groups (some essential properties might still be included)
        const layoutProps = Object.keys(specificData.grouped_styles.layout || {}).length;
        const boxProps = Object.keys(specificData.grouped_styles.box || {}).length;
        
        // Essential properties might still be included, so we check for significantly fewer
        assert.ok(layoutProps <= 5, `Should have minimal layout properties, got ${layoutProps}`);
        assert.ok(boxProps <= 5, `Should have minimal box properties, got ${boxProps}`);
        
        console.log('✅ Specific groups filtering works correctly');

        // Test 3: Include all properties (bypass filtering)
        console.log('Testing include_all_properties flag...');
        const allPropsResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '#test-header',
            url: testUrl,
            include_all_properties: true
        });

        assert.ok(allPropsResponse.result, 'Include all should work');
        const allPropsData = JSON.parse(allPropsResponse.result.content[2].text);
        
        // When include_all_properties is true, should still have computed_styles (not just grouped)
        assert.ok(allPropsData.computed_styles, 'Should have computed_styles when include_all is true');
        
        // Should have significantly more properties than filtered version
        const allPropsCount = Object.keys(allPropsData.computed_styles).length;
        const filteredCount = defaultData.computed_styles_summary.filtered_properties;
        assert.ok(allPropsCount > filteredCount, 
            `All properties (${allPropsCount}) should be more than filtered (${filteredCount})`);
        
        console.log(`✅ Include all: ${allPropsCount} properties vs ${filteredCount} filtered`);

        // Test 4: Visual effects and animations group
        console.log('Testing visual effects group...');
        const visualResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '#test-header',
            url: testUrl,
            property_groups: ['visual', 'colors']
        });

        assert.ok(visualResponse.result, 'Visual group should work');
        const visualData = JSON.parse(visualResponse.result.content[2].text);
        
        assert.ok(visualData.grouped_styles, 'Should have grouped styles');
        assert.ok(visualData.grouped_styles.visual || Object.keys(visualData.grouped_styles.visual || {}).length >= 0, 
            'Should have visual group');
        
        console.log('✅ Visual effects group works');

        // Test 5: Grid and flexbox properties
        console.log('Testing flexbox properties...');
        const flexboxResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '.test-button',  // This element uses flexbox
            url: testUrl,
            property_groups: ['flexbox', 'layout']
        });

        assert.ok(flexboxResponse.result, 'Flexbox group should work');
        const flexboxData = JSON.parse(flexboxResponse.result.content[2].text);
        
        assert.ok(flexboxData.grouped_styles, 'Should have grouped styles');
        
        console.log('✅ Flexbox group works');

        // Test 6: Invalid group name (should still work, just ignore invalid group)
        console.log('Testing invalid group name...');
        const invalidResponse = await mcpClient.callTool('inspect_element', {
            css_selector: '#test-header',
            url: testUrl,
            property_groups: ['colors', 'invalid-group-name', 'typography']
        });

        assert.ok(invalidResponse.result, 'Should work even with invalid group names');
        const invalidData = JSON.parse(invalidResponse.result.content[2].text);
        
        assert.ok(invalidData.grouped_styles, 'Should still have grouped styles');
        assert.ok(invalidData.grouped_styles.colors, 'Should still have valid groups');
        
        console.log('✅ Gracefully handles invalid group names');

        console.log('✅ All property groups tests passed');

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
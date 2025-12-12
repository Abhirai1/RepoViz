// ===== CONFIGURATION =====
const config = {
    githubToken: '', // Optional: Add your GitHub token for higher rate limits
    maxFiles: 200,
    supportedExtensions: ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c', '.cs', '.go', '.rb', '.php', '.html', '.css', '.json', '.md']
};

// ===== STATE =====
let currentRepo = null;
let graphData = { nodes: [], links: [] };
let simulation = null;
let svg = null;
let zoom = null;
let showLabels = true;
let detailedDependencies = []; // Stores file dependencies with import info
let currentFileNode = null; // Currently viewed file

// ===== FILE TYPE COLORS =====
const fileColors = {
    '.js': '#f1e05a',
    '.jsx': '#f1e05a',
    '.ts': '#2b7489',
    '.tsx': '#2b7489',
    '.py': '#3572a5',
    '.java': '#b07219',
    '.cpp': '#f34b7d',
    '.c': '#555555',
    '.cs': '#178600',
    '.go': '#00add8',
    '.rb': '#701516',
    '.php': '#4f5d95',
    '.html': '#e34c26',
    '.css': '#563d7c',
    '.json': '#292929',
    '.md': '#083fa1',
    'default': '#8b8b8b'
};

// ===== UTILITY FUNCTIONS =====
function showToast(message) {
    const toast = document.getElementById('errorToast');
    const toastMessage = document.getElementById('toastMessage');
    toastMessage.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function getFileExtension(filename) {
    const match = filename.match(/\.[^.]+$/);
    return match ? match[0] : '';
}

function getFileColor(filename) {
    const ext = getFileExtension(filename);
    return fileColors[ext] || fileColors.default;
}

function parseRepoUrl(url) {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (match) {
        return {
            owner: match[1],
            repo: match[2].replace('.git', '')
        };
    }
    return null;
}

// ===== GITHUB API FUNCTIONS =====
async function fetchGitHubAPI(url) {
    const headers = {
        'Accept': 'application/vnd.github.v3+json'
    };
    
    if (config.githubToken) {
        headers['Authorization'] = `token ${config.githubToken}`;
    }
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
    }
    
    return response.json();
}

async function getRepoContents(owner, repo, path = '') {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    return fetchGitHubAPI(url);
}

async function getFileContent(owner, repo, path) {
    try {
        const data = await getRepoContents(owner, repo, path);
        if (data.content) {
            return atob(data.content);
        }
    } catch (error) {
        console.error(`Error fetching file content: ${path}`, error);
    }
    return null;
}

async function scanRepository(owner, repo, path = '', files = []) {
    try {
        const contents = await getRepoContents(owner, repo, path);
        
        for (const item of contents) {
            if (files.length >= config.maxFiles) {
                break;
            }
            
            if (item.type === 'file') {
                const ext = getFileExtension(item.name);
                if (config.supportedExtensions.includes(ext)) {
                    files.push({
                        name: item.name,
                        path: item.path,
                        size: item.size,
                        url: item.download_url
                    });
                }
            } else if (item.type === 'dir' && !item.name.startsWith('.') && item.name !== 'node_modules') {
                await scanRepository(owner, repo, item.path, files);
            }
        }
        
        return files;
    } catch (error) {
        console.error('Error scanning repository:', error);
        throw error;
    }
}

// ===== DEPENDENCY ANALYSIS =====
function analyzeDependencies(files, contents) {
    const dependencies = [];
    detailedDependencies = [];
    
    files.forEach((file, index) => {
        const content = contents[index];
        if (!content) return;
        
        const imports = extractImportsDetailed(content, file.path);
        
        imports.forEach(importInfo => {
            const targetIndex = files.findIndex(f => {
                const normalizedPath = importInfo.path.replace(/^\.\//, '').replace(/^\.\.\//, '');
                return f.path.includes(normalizedPath) || f.name === importInfo.path || f.path.endsWith(importInfo.path + getFileExtension(f.name));
            });
            
            if (targetIndex !== -1) {
                dependencies.push({
                    source: index,
                    target: targetIndex
                });
                
                // Store detailed dependency info
                detailedDependencies.push({
                    sourceIndex: index,
                    targetIndex: targetIndex,
                    importStatement: importInfo.statement,
                    importedNames: importInfo.names,
                    lineNumber: importInfo.line,
                    path: importInfo.path,
                    targetFile: files[targetIndex]
                });
            }
        });
    });
    
    return dependencies;
}

function extractImportsDetailed(content, filePath) {
    const imports = [];
    const ext = getFileExtension(filePath);
    const lines = content.split('\n');
    
    // JavaScript/TypeScript imports
    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        const importRegex = /import\s+(?:([\w\s{},*]+)\s+from\s+)?['"]([^'"]+)['"]\s*/g;
        const requireRegex = /(?:const|let|var)\s+([\w{},\s]+)\s*=\s*require\(['"]([^'"]+)['"]\)/g;
        
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            if (!match[2].startsWith('@') && !match[2].startsWith('http') && match[2].startsWith('.')) {
                const lineNumber = content.substring(0, match.index).split('\n').length;
                imports.push({
                    statement: match[0],
                    names: match[1] ? match[1].trim().split(',').map(n => n.trim()) : [],
                    path: match[2],
                    line: lineNumber
                });
            }
        }
        while ((match = requireRegex.exec(content)) !== null) {
            if (!match[2].startsWith('@') && !match[2].startsWith('http') && match[2].startsWith('.')) {
                const lineNumber = content.substring(0, match.index).split('\n').length;
                imports.push({
                    statement: match[0],
                    names: match[1] ? match[1].trim().split(',').map(n => n.trim()) : [],
                    path: match[2],
                    line: lineNumber
                });
            }
        }
    }
    
    // Python imports
    if (ext === '.py') {
        const fromImportRegex = /from\s+([\.\w]+)\s+import\s+([\w,\s*]+)/g;
        const importRegex = /import\s+([\.\w]+)/g;
        
        let match;
        while ((match = fromImportRegex.exec(content)) !== null) {
            if (match[1].startsWith('.')) {
                const lineNumber = content.substring(0, match.index).split('\n').length;
                imports.push({
                    statement: match[0],
                    names: match[2].split(',').map(n => n.trim()),
                    path: match[1],
                    line: lineNumber
                });
            }
        }
        while ((match = importRegex.exec(content)) !== null) {
            if (match[1].startsWith('.')) {
                const lineNumber = content.substring(0, match.index).split('\n').length;
                imports.push({
                    statement: match[0],
                    names: [match[1]],
                    path: match[1],
                    line: lineNumber
                });
            }
        }
    }
    
    return imports;
}

function findImportUsages(content, importedNames, filePath, importLine) {
    const usages = [];
    const ext = getFileExtension(filePath);
    const lines = content.split('\n');
    
    importedNames.forEach(name => {
        // Clean the name - handle destructured imports, default imports, etc.
        let cleanName = name.trim();
        
        // Handle "{ Component }" -> "Component"
        cleanName = cleanName.replace(/[{}]/g, '').trim();
        
        // Handle "Component as Comp" -> "Comp" (use the alias)
        if (cleanName.includes(' as ')) {
            cleanName = cleanName.split(' as ')[1].trim();
        }
        
        // Handle "* as module" -> "module"
        if (cleanName.startsWith('* as ')) {
            cleanName = cleanName.substring(5).trim();
        }
        
        // Handle default imports and named imports
        cleanName = cleanName.split(',')[0].trim();
        
        if (!cleanName || cleanName === '*') return;
        
        lines.forEach((line, index) => {
            const lineNumber = index + 1;
            
            // Skip the import line itself
            if (lineNumber === importLine) return;
            
            // Skip other import/require lines
            if (line.trim().startsWith('import ') || line.trim().startsWith('from ')) return;
            if (line.includes('require(') && line.includes(cleanName) && line.includes('=')) return;
            
            // Look for usage of imported name
            const usageRegex = new RegExp(`\\b${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
            let match;
            while ((match = usageRegex.exec(line)) !== null) {
                usages.push({
                    line: lineNumber,
                    column: match.index,
                    name: cleanName,
                    context: line.trim()
                });
            }
        });
    });
    
    return usages;
}

// ===== GRAPH VISUALIZATION =====
function initGraph() {
    const container = document.getElementById('graphContainer');
    container.innerHTML = '';
    
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    svg = d3.select('#graphContainer')
        .append('svg')
        .attr('width', width)
        .attr('height', height);
    
    const defs = svg.append('defs');
    
    // Arrow marker for links
    defs.append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10')
        .attr('refX', 20)
        .attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', 8)
        .attr('markerHeight', 8)
        .append('path')
        .attr('d', 'M 0,-5 L 10,0 L 0,5')
        .attr('fill', '#64748b')
        .attr('opacity', 0.6);
    
    const g = svg.append('g');
    
    zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
            g.attr('transform', event.transform);
        });
    
    svg.call(zoom);
    
    return { svg, g, width, height };
}

function createGraph(files, dependencies) {
    const { g, width, height } = initGraph();
    
    // Create nodes
    graphData.nodes = files.map((file, i) => ({
        id: i,
        name: file.name,
        path: file.path,
        size: file.size,
        color: getFileColor(file.name),
        x: width / 2 + (Math.random() - 0.5) * 200,
        y: height / 2 + (Math.random() - 0.5) * 200
    }));
    
    // Create links
    graphData.links = dependencies;
    
    // Create force simulation
    simulation = d3.forceSimulation(graphData.nodes)
        .force('link', d3.forceLink(graphData.links)
            .id(d => d.id)
            .distance(100))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(30));
    
    // Draw links
    const link = g.append('g')
        .selectAll('line')
        .data(graphData.links)
        .enter()
        .append('line')
        .attr('stroke', '#64748b')
        .attr('stroke-opacity', 0.4)
        .attr('stroke-width', 2)
        .attr('marker-end', 'url(#arrowhead)');
    
    // Draw nodes
    const node = g.append('g')
        .selectAll('g')
        .data(graphData.nodes)
        .enter()
        .append('g')
        .call(d3.drag()
            .on('start', dragStarted)
            .on('drag', dragged)
            .on('end', dragEnded));
    
    // Node circles
    node.append('circle')
        .attr('r', d => Math.max(8, Math.min(20, Math.sqrt(d.size / 100))))
        .attr('fill', d => d.color)
        .attr('stroke', '#fff')
        .attr('stroke-width', 2)
        .style('cursor', 'pointer')
        .on('click', (event, d) => {
            showFileModal(d);
        })
        .on('mouseover', function(event, d) {
            d3.select(this)
                .transition()
                .duration(200)
                .attr('r', d => Math.max(12, Math.min(24, Math.sqrt(d.size / 100) + 4)))
                .attr('stroke-width', 3);
            
            // Show tooltip
            showTooltip(event, d);
        })
        .on('mouseout', function(event, d) {
            d3.select(this)
                .transition()
                .duration(200)
                .attr('r', d => Math.max(8, Math.min(20, Math.sqrt(d.size / 100))))
                .attr('stroke-width', 2);
            
            hideTooltip();
        });
    
    // Node labels
    const labels = node.append('text')
        .text(d => d.name)
        .attr('x', 0)
        .attr('y', 25)
        .attr('text-anchor', 'middle')
        .attr('fill', '#f1f5f9')
        .attr('font-size', '10px')
        .attr('pointer-events', 'none')
        .style('display', showLabels ? 'block' : 'none');
    
    // Update positions on each tick
    simulation.on('tick', () => {
        link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);
        
        node.attr('transform', d => `translate(${d.x},${d.y})`);
    });
    
    // Update stats
    document.getElementById('fileCount').textContent = files.length;
    document.getElementById('dependencyCount').textContent = dependencies.length;
}

function showTooltip(event, data) {
    const tooltip = d3.select('body')
        .append('div')
        .attr('class', 'graph-tooltip')
        .style('position', 'absolute')
        .style('background', '#1e293b')
        .style('color', '#f1f5f9')
        .style('padding', '8px 12px')
        .style('border-radius', '6px')
        .style('border', '1px solid #334155')
        .style('font-size', '12px')
        .style('pointer-events', 'none')
        .style('z-index', '1000')
        .style('box-shadow', '0 4px 12px rgba(0,0,0,0.3)')
        .html(`
            <strong>${data.name}</strong><br>
            Path: ${data.path}<br>
            Size: ${(data.size / 1024).toFixed(2)} KB
        `)
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY + 10) + 'px');
}

function hideTooltip() {
    d3.selectAll('.graph-tooltip').remove();
}

// Drag functions
function dragStarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
}

function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
}

function dragEnded(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
}

// ===== MODAL FUNCTIONS =====
async function showFileModal(fileNode) {
    const modal = document.getElementById('codeModal');
    const modalTitle = document.getElementById('modalTitle');
    const codeContent = document.getElementById('codeContent');
    const linesCount = document.getElementById('linesCount');
    const fileSize = document.getElementById('fileSize');
    const dependenciesPanel = document.getElementById('dependenciesPanel');
    const dependenciesList = document.getElementById('dependenciesList');
    const dependenciesInfo = document.getElementById('dependenciesInfo');
    
    currentFileNode = fileNode;
    modalTitle.textContent = fileNode.path;
    codeContent.textContent = 'Loading...';
    
    modal.classList.add('active');
    
    try {
        const content = await getFileContent(currentRepo.owner, currentRepo.repo, fileNode.path);
        
        if (content) {
            const lines = content.split('\n').length;
            const size = (new Blob([content]).size / 1024).toFixed(2);
            
            // Get dependencies for this file
            const fileDeps = detailedDependencies.filter(dep => dep.sourceIndex === fileNode.id);
            dependenciesInfo.textContent = fileDeps.length;
            
            // Show dependencies panel if there are any
            if (fileDeps.length > 0) {
                dependenciesPanel.style.display = 'block';
                dependenciesList.innerHTML = '';
                
                // Use the same color palette as highlighting
                const colors = [
                    '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
                    '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
                    '#6366f1', '#a855f7', '#eab308', '#22c55e', '#0ea5e9'
                ];
                
                fileDeps.forEach((dep, index) => {
                    const highlightColor = colors[index % colors.length];
                    const depItem = document.createElement('div');
                    depItem.className = 'dependency-item';
                    depItem.style.setProperty('--dep-color', highlightColor);
                    depItem.innerHTML = `
                        <div class="dependency-badge" style="background: ${highlightColor}; box-shadow: 0 0 10px ${highlightColor}80;"></div>
                        <div class="dependency-info">
                            <strong>${dep.targetFile.name}</strong>
                            <span class="dependency-path">${dep.targetFile.path}</span>
                            <span class="dependency-imports">Imports: ${dep.importedNames.join(', ')}</span>
                        </div>
                        <button class="jump-to-node" data-node-id="${dep.targetIndex}" title="Jump to node in graph">
                            <i class="fas fa-external-link-alt"></i>
                        </button>
                    `;
                    dependenciesList.appendChild(depItem);
                });
                
                // Add click handlers for jump buttons
                document.querySelectorAll('.jump-to-node').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const nodeId = parseInt(e.currentTarget.dataset.nodeId);
                        jumpToNode(nodeId);
                    });
                });
            } else {
                dependenciesPanel.style.display = 'none';
            }
            
            // Apply syntax highlighting first
            codeContent.textContent = content;
            linesCount.textContent = lines;
            fileSize.textContent = size;
            
            const ext = getFileExtension(fileNode.name);
            const language = ext.substring(1);
            codeContent.className = `language-${language}`;
            hljs.highlightElement(codeContent);
            
            // Now add dependency highlighting
            if (fileDeps.length > 0) {
                highlightDependencies(codeContent, content, fileDeps);
            }
            
            // Store content for copy/download
            codeContent.dataset.content = content;
            codeContent.dataset.filename = fileNode.name;
        }
    } catch (error) {
        codeContent.textContent = 'Error loading file content.';
        showToast('Failed to load file content');
    }
}

function highlightDependencies(codeElement, content, fileDeps) {
    const lines = content.split('\n');
    let processedContent = codeElement.innerHTML;
    
    // Create a color palette with distinct colors for each dependency
    const colors = [
        '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
        '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
        '#6366f1', '#a855f7', '#eab308', '#22c55e', '#0ea5e9'
    ];
    
    // Track all replacements to avoid conflicts
    const replacements = [];
    
    fileDeps.forEach((dep, depIndex) => {
        // Use a distinct color for each dependency (cycle through palette)
        const color = colors[depIndex % colors.length];
        
        // Find and highlight all usages of imported names
        if (dep.importedNames && dep.importedNames.length > 0) {
            const usages = findImportUsages(content, dep.importedNames, currentFileNode.path, dep.lineNumber);
            
            // Group usages by line for better processing
            const usagesByLine = {};
            usages.forEach(usage => {
                if (!usagesByLine[usage.line]) {
                    usagesByLine[usage.line] = [];
                }
                usagesByLine[usage.line].push(usage);
            });
            
            // Store replacements with metadata
            usages.forEach(usage => {
                replacements.push({
                    name: usage.name,
                    line: usage.line,
                    depIndex: depIndex,
                    nodeId: dep.targetIndex,
                    color: color,
                    fileName: dep.targetFile.name
                });
            });
        }
    });
    
    // Sort replacements by length (longest first) to avoid partial replacements
    replacements.sort((a, b) => b.name.length - a.name.length);
    
    // Remove duplicates (same name, prefer first occurrence)
    const uniqueReplacements = [];
    const seen = new Set();
    replacements.forEach(rep => {
        if (!seen.has(rep.name)) {
            seen.add(rep.name);
            uniqueReplacements.push(rep);
        }
    });
    
    // Apply highlighting to each unique imported name
    uniqueReplacements.forEach(rep => {
        const escapedName = rep.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // Create a more sophisticated regex that avoids replacing inside:
        // - HTML tags
        // - Already highlighted spans
        // - Import/require statements
        const parts = processedContent.split(new RegExp(`(${escapedName})`, 'g'));
        let result = '';
        let inTag = false;
        let inHighlight = false;
        let inImport = false;
        
        parts.forEach((part, i) => {
            // Check context
            if (part.includes('<span class="dependency-highlight"')) inHighlight = true;
            if (part.includes('</span>') && inHighlight) inHighlight = false;
            if (part.includes('<')) inTag = true;
            if (part.includes('>')) inTag = false;
            
            // Check if we're in an import line (look back in result)
            const recentContext = result.slice(-200);
            inImport = recentContext.includes('import ') || recentContext.includes('require(');
            if (recentContext.includes('\n') || recentContext.includes('<br>')) {
                // New line, reset import check
                const lastLineBreak = Math.max(recentContext.lastIndexOf('\n'), recentContext.lastIndexOf('<br>'));
                const currentLine = recentContext.slice(lastLineBreak);
                inImport = currentLine.includes('import ') || currentLine.includes('require(');
            }
            
            // Only highlight if it's the exact match and not in a problematic context
            if (part === rep.name && !inTag && !inHighlight && !inImport) {
                result += `<span class="dependency-highlight" data-dep-index="${rep.depIndex}" data-node-id="${rep.nodeId}" style="background: ${rep.color}40; border-bottom: 2px solid ${rep.color}; cursor: pointer; padding: 1px 3px; border-radius: 2px;" title="From: ${rep.fileName} - Click to navigate">${part}</span>`;
            } else {
                result += part;
            }
        });
        
        processedContent = result;
    });
    
    codeElement.innerHTML = processedContent;
    
    // Add click handlers to highlights
    document.querySelectorAll('.dependency-highlight').forEach(highlight => {
        highlight.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const nodeId = parseInt(e.target.dataset.nodeId);
            const depIndex = parseInt(e.target.dataset.depIndex);
            
            // Close current modal and navigate
            closeModal();
            showToast(`Navigating to: ${fileDeps[depIndex].targetFile.name}`);
            
            // Jump to node and open it after animation
            jumpToNodeAndOpen(nodeId);
        });
        
        // Add hover effect
        highlight.addEventListener('mouseenter', (e) => {
            e.target.style.transform = 'translateY(-1px)';
            e.target.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
        });
        
        highlight.addEventListener('mouseleave', (e) => {
            e.target.style.transform = 'translateY(0)';
            e.target.style.boxShadow = 'none';
        });
    });
}

function jumpToNode(nodeId) {
    highlightNodeInGraph(nodeId);
    closeModal();
    
    // Focus on the node
    const node = graphData.nodes.find(n => n.id === nodeId);
    if (node && svg) {
        const container = document.getElementById('graphContainer');
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        // Center the node
        const scale = 1.5;
        const x = width / 2 - node.x * scale;
        const y = height / 2 - node.y * scale;
        
        svg.transition()
            .duration(750)
            .call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale));
    }
}

function jumpToNodeAndOpen(nodeId) {
    // Close current modal first
    const node = graphData.nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    // Highlight the path and zoom
    highlightNodeInGraph(nodeId);
    
    // Focus on the node
    if (svg) {
        const container = document.getElementById('graphContainer');
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        // Center the node with animation
        const scale = 1.5;
        const x = width / 2 - node.x * scale;
        const y = height / 2 - node.y * scale;
        
        svg.transition()
            .duration(750)
            .call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale))
            .on('end', () => {
                // After zoom animation completes, open the node's modal
                setTimeout(() => {
                    showFileModal(node);
                }, 200);
            });
    }
}

function highlightNodeInGraph(nodeId) {
    // Reset all nodes first
    d3.selectAll('#graphContainer circle')
        .transition()
        .duration(200)
        .attr('stroke-width', 2)
        .attr('stroke', '#fff')
        .attr('opacity', 0.5);
    
    // Highlight the target node with pulsing animation
    d3.selectAll('#graphContainer circle')
        .filter(d => d.id === nodeId)
        .transition()
        .duration(300)
        .attr('stroke-width', 5)
        .attr('stroke', '#10b981')
        .attr('opacity', 1)
        .transition()
        .duration(400)
        .attr('stroke-width', 8)
        .attr('r', d => Math.max(12, Math.min(24, Math.sqrt(d.size / 100) + 6)))
        .transition()
        .duration(400)
        .attr('stroke-width', 5)
        .attr('r', d => Math.max(8, Math.min(20, Math.sqrt(d.size / 100))));
    
    // Also highlight source node if exists
    if (currentFileNode) {
        d3.selectAll('#graphContainer circle')
            .filter(d => d.id === currentFileNode.id)
            .transition()
            .duration(300)
            .attr('stroke-width', 4)
            .attr('stroke', '#3b82f6')
            .attr('opacity', 1);
    }
    
    // Reset all links first
    d3.selectAll('#graphContainer line')
        .transition()
        .duration(200)
        .attr('stroke-opacity', 0.15)
        .attr('stroke-width', 2)
        .attr('stroke', '#64748b');
    
    // Highlight the connection path
    d3.selectAll('#graphContainer line')
        .filter(d => {
            if (currentFileNode) {
                return (d.source.id === currentFileNode.id && d.target.id === nodeId) ||
                       (d.target.id === currentFileNode.id && d.source.id === nodeId);
            }
            return false;
        })
        .transition()
        .duration(300)
        .attr('stroke-opacity', 1)
        .attr('stroke-width', 4)
        .attr('stroke', '#10b981')
        .transition()
        .duration(500)
        .attr('stroke-width', 3);
    
    // Restore other nodes after a delay
    setTimeout(() => {
        d3.selectAll('#graphContainer circle')
            .filter(d => d.id !== nodeId && (!currentFileNode || d.id !== currentFileNode.id))
            .transition()
            .duration(500)
            .attr('opacity', 1);
        
        d3.selectAll('#graphContainer line')
            .transition()
            .duration(500)
            .attr('stroke-opacity', 0.4);
    }, 1500);
}

function closeModal() {
    const modal = document.getElementById('codeModal');
    modal.classList.remove('active');
}

function backToInput() {
    document.getElementById('graphSection').style.display = 'none';
    document.getElementById('hero').style.display = 'block';
    
    // Reset graph
    if (svg) {
        d3.select('#graphContainer').selectAll('*').remove();
    }
    graphData = { nodes: [], links: [] };
    simulation = null;
}

// ===== CONTROL FUNCTIONS =====
function setupControls() {
    document.getElementById('zoomIn').addEventListener('click', () => {
        svg.transition().call(zoom.scaleBy, 1.3);
    });
    
    document.getElementById('zoomOut').addEventListener('click', () => {
        svg.transition().call(zoom.scaleBy, 0.7);
    });
    
    document.getElementById('resetView').addEventListener('click', () => {
        svg.transition().call(zoom.transform, d3.zoomIdentity);
    });
    
    document.getElementById('toggleLabels').addEventListener('click', () => {
        showLabels = !showLabels;
        d3.selectAll('#graphContainer text')
            .style('display', showLabels ? 'block' : 'none');
    });
    
    document.getElementById('changeLayout').addEventListener('click', () => {
        if (simulation) {
            simulation.alpha(1).restart();
        }
    });
}

// ===== MAIN VISUALIZATION FUNCTION =====
async function visualizeRepository() {
    const repoUrl = document.getElementById('repoUrl').value.trim();
    
    if (!repoUrl) {
        showToast('Please enter a repository URL');
        return;
    }
    
    const repoInfo = parseRepoUrl(repoUrl);
    if (!repoInfo) {
        showToast('Invalid GitHub repository URL');
        return;
    }
    
    currentRepo = repoInfo;
    
    // Show loading state
    document.getElementById('hero').style.display = 'none';
    document.getElementById('loadingState').style.display = 'block';
    document.getElementById('graphSection').style.display = 'none';
    
    try {
        // Scan repository
        const files = await scanRepository(repoInfo.owner, repoInfo.repo);
        
        if (files.length === 0) {
            showToast('No supported files found in repository');
            document.getElementById('hero').style.display = 'block';
            document.getElementById('loadingState').style.display = 'none';
            return;
        }
        
        // Fetch file contents for dependency analysis (limited)
        const contentsToAnalyze = files.slice(0, 50); // Limit to prevent rate limiting
        const contents = await Promise.all(
            contentsToAnalyze.map(f => getFileContent(repoInfo.owner, repoInfo.repo, f.path))
        );
        
        // Analyze dependencies
        const dependencies = analyzeDependencies(contentsToAnalyze, contents);
        
        // Show graph section
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('graphSection').style.display = 'block';
        
        // Create graph
        createGraph(files, dependencies);
        
    } catch (error) {
        console.error('Error visualizing repository:', error);
        showToast('Failed to visualize repository. Please check the URL and try again.');
        document.getElementById('hero').style.display = 'block';
        document.getElementById('loadingState').style.display = 'none';
    }
}

// ===== EVENT LISTENERS =====
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('visualizeBtn').addEventListener('click', visualizeRepository);
    
    document.getElementById('repoUrl').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            visualizeRepository();
        }
    });
    
    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('modalBackdrop').addEventListener('click', closeModal);
    
    // Back button
    document.getElementById('backToInput').addEventListener('click', backToInput);
    
    document.getElementById('copyCode').addEventListener('click', () => {
        const codeContent = document.getElementById('codeContent');
        const content = codeContent.dataset.content;
        if (content) {
            navigator.clipboard.writeText(content);
            showToast('Code copied to clipboard!');
        }
    });
    
    document.getElementById('downloadCode').addEventListener('click', () => {
        const codeContent = document.getElementById('codeContent');
        const content = codeContent.dataset.content;
        const filename = codeContent.dataset.filename;
        if (content) {
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            showToast('File downloaded!');
        }
    });
    
    setupControls();
    
    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
        }
    });
});

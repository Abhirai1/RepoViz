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
    
    files.forEach((file, index) => {
        const content = contents[index];
        if (!content) return;
        
        const imports = extractImports(content, file.path);
        
        imports.forEach(importPath => {
            const targetIndex = files.findIndex(f => {
                const normalizedPath = importPath.replace(/^\.\//, '').replace(/^\.\.\//, '');
                return f.path.includes(normalizedPath) || f.name === importPath;
            });
            
            if (targetIndex !== -1) {
                dependencies.push({
                    source: index,
                    target: targetIndex
                });
            }
        });
    });
    
    return dependencies;
}

function extractImports(content, filePath) {
    const imports = [];
    const ext = getFileExtension(filePath);
    
    // JavaScript/TypeScript imports
    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        const importRegex = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
        const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
        
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            if (!match[1].startsWith('@') && !match[1].startsWith('http')) {
                imports.push(match[1]);
            }
        }
        while ((match = requireRegex.exec(content)) !== null) {
            if (!match[1].startsWith('@') && !match[1].startsWith('http')) {
                imports.push(match[1]);
            }
        }
    }
    
    // Python imports
    if (ext === '.py') {
        const importRegex = /(?:from|import)\s+([^\s]+)/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            if (match[1] !== 'import' && !match[1].includes('.')) {
                imports.push(match[1]);
            }
        }
    }
    
    // Java imports
    if (ext === '.java') {
        const importRegex = /import\s+([^\s;]+);/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            const className = match[1].split('.').pop();
            imports.push(className);
        }
    }
    
    return imports;
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
    
    modalTitle.textContent = fileNode.path;
    codeContent.textContent = 'Loading...';
    
    modal.classList.add('active');
    
    try {
        const content = await getFileContent(currentRepo.owner, currentRepo.repo, fileNode.path);
        
        if (content) {
            const lines = content.split('\n').length;
            const size = (new Blob([content]).size / 1024).toFixed(2);
            
            codeContent.textContent = content;
            linesCount.textContent = lines;
            fileSize.textContent = size;
            
            // Apply syntax highlighting
            const ext = getFileExtension(fileNode.name);
            const language = ext.substring(1);
            codeContent.className = `language-${language}`;
            hljs.highlightElement(codeContent);
            
            // Store content for copy/download
            codeContent.dataset.content = content;
            codeContent.dataset.filename = fileNode.name;
        }
    } catch (error) {
        codeContent.textContent = 'Error loading file content.';
        showToast('Failed to load file content');
    }
}

function closeModal() {
    const modal = document.getElementById('codeModal');
    modal.classList.remove('active');
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

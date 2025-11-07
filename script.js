// --- Helper: Debounce ---
function debounce(func, wait, immediate) {
    let timeout;
    return function() {
        const context = this, args = arguments;
        const later = function() {
            timeout = null;
            if (!immediate) func.apply(context, args);
        };
        const callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func.apply(context, args);
    };
};

// --- Main script entry ---
document.addEventListener('DOMContentLoaded', () => {

    // --- 1. Map Initialization (Leaflet) ---
    const map = L.map('map').setView([0, 0], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    const vesselTracksLayer = L.layerGroup().addTo(map);
    const geographyLayer = L.layerGroup().addTo(map);

    // Map Legend
    const legend = L.control({position: 'bottomright'});
    legend.onAdd = function (map) {
        const div = L.DomUtil.create('div', 'info legend');
        div.style.backgroundColor = 'rgba(255, 255, 255, 0.9)';
        div.style.padding = '10px';
        div.style.borderRadius = '5px';
        div.style.border = '1px solid #ccc';
        div.style.lineHeight = '1.5';

        div.innerHTML = '<h4>Track legend</h4>' +
            '<i style="background: #dc3545; width: 18px; height: 3px; display: inline-block; margin-right: 5px; vertical-align: middle; opacity: 0.8;"></i> SouthSeafood Exp.<br>' +
            '<i style="background: #FFA500; width: 18px; height: 3px; display: inline-block; margin-right: 5px; vertical-align: middle; opacity: 0.8;"></i> Other suspect<br>' +
            '<i style="background: #222222; border-top: 3px dashed #222; width: 18px; height: 0px; display: inline-block; margin-right: 5px; vertical-align: middle; opacity: 0.7;"></i> Gap Transponder';
        return div;
    };
    legend.addTo(map);

    const tooltip = d3.select("#tooltip"); 

    // --- 2. Data Loading (D3.js) ---
    Promise.all([
        d3.json('mc2.json'), 
        d3.json('Oceanus Information/Oceanus Geography.geojson'),
        d3.json('Oceanus Information/Oceanus Geography Nodes.json')
    ]).then(([data, geography, locationNodes]) => {
        
        console.log("✅ DATA LOADED SUCCESSFULLY.");

        let brushedDateRange = null; 
        let chartBrush = null; 
        let timelineSvg = null;
        let timelineXScale = null;
        let timelineHeight = null;
        
        const NOME_TIPO_TRACCIA = "Event.TransportEvent.TransponderPing";
        const NOME_PROPRIETA_DATA_LINK = 'time';
        const NOME_PROPRIETA_COMPAGNIA = 'company';

        const graphNodes = data.nodes;
        const edges = data.links;
        
        const vessels = graphNodes.filter(n => n.type && n.type.startsWith("Entity.Vessel"));
        const cargoReports = graphNodes.filter(n => n.type && n.type.startsWith("Entity.Document"));
        const transactionLinks = edges.filter(e => e.type === "Event.Transaction");

        // --- Data Prep: Forbidden Zones ---
        const allZoneKinds = [...new Set(geography.features
            .filter(f => f.properties && f.properties["*Kind"])
            .map(f => f.properties["*Kind"]))];
        console.log("TIPI DI ZONE DISPONIBILI:", allZoneKinds);

        const SUSPICIOUS_KINDS = ["Ecological Preserve"]; 
        const forbiddenZones = geography.features.filter(f => 
            f.properties && f.properties["*Kind"] && SUSPICIOUS_KINDS.includes(f.properties["*Kind"])
        );
        console.log(`Found ${forbiddenZones.length} forbidden zones matching criteria.`);
        
        // --- Data Prep: Timeline Data ---
        const dateParser = d3.timeParse("%Y-%m-%d");
        const allPortExitData = transactionLinks.map(link => {
            const cargoNode = cargoReports.find(c => c.id === link.source);
            const quantity = cargoNode ? parseFloat(cargoNode.qty_tons) : 0;
            return {
                date: dateParser(link.date),
                quantity: isNaN(quantity) ? 0 : quantity,
            };
        }).filter(d => d.date);

        // --- 3. Visualization Logic (Geography) ---
        const geoJSONLayer = L.geoJson(geography, {
            style: (feature) => {
                if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
                    let regionColor = "#006400";
                    if (feature.properties && SUSPICIOUS_KINDS.includes(feature.properties["*Kind"])) {
                        regionColor = "#8B0000"; 
                    }
                    return { color: regionColor, weight: 1, fillOpacity: 0.3 };
                }
                return {};
            },
            pointToLayer: (feature, latlng) => {
                return L.marker(latlng)
                        .on('mouseover', function (e) {
                            this.setIcon(L.icon({ 
                                iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
                                iconSize: [40, 60], 
                                iconAnchor: [20, 60]
                            }));
                        })
                        .on('mouseout', function (e) {
                            this.setIcon(L.icon({
                                iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
                                iconSize: [25, 41],
                                iconAnchor: [12, 41]
                            }));
                        });
            },
            onEachFeature: function (feature, layer) {
                if (feature.properties && feature.properties.Name) {
                    layer.bindTooltip(feature.properties.Name); 
                }
                if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
                    layer.on({
                        mouseover: (e) => { 
                            e.target.setStyle({
                                weight: 4, 
                                fillOpacity: 0.6 
                            });
                        },
                        mouseout: (e) => {
                            geoJSONLayer.resetStyle(e.target); 
                        },
                        click: (e) => {
                            const clickedZoneFeature = e.target.feature;
                            const zoneName = clickedZoneFeature.properties.Name || "Unknown Zone";
                            const isForbidden = SUSPICIOUS_KINDS.includes(clickedZoneFeature.properties["*Kind"]);

                            if (!isForbidden) return;

                            const infoBox = d3.select("#info-box");
                            infoBox.html(""); 
                            infoBox.append("h4").text("Selected Zone:");
                            infoBox.append("p").text(zoneName);

                            infoBox.append("h4").text("Available Fish Species:");
                            
                            let fishSpecies = [];
                            
                            switch (zoneName) {
                                case "Ghoti Preserve":
                                    fishSpecies = ["Wrasse", "Beauvoir", "Helenaa", "Offidiaa"];
                                    break;
                                case "Nemo Reef":
                                    fishSpecies = ["Wrasse", "Tuna", "Birdseye", "Beauvoir", "Helenaa"];
                                    break;
                                case "Don Limpet Preserve":
                                    fishSpecies = ["Tuna", "Birdseye", "Beauvoir", "Helenaa", "Sockfish"];
                                    break;
                                default:
                                    fishSpecies = [];
                                    break;
                            }
                            
                            if (fishSpecies.length > 0) {
                                const fishList = infoBox.append("ul");
                                fishSpecies.forEach(fish => {
                                    fishList.append("li").text(fish); 
                                });
                            } else {
                                infoBox.append("p").text("No specific fish data available for this zone.");
                            }

                            let pingsInThisZone = [];
                            
                            let relevantEdges = edges.filter(e => e.type === NOME_TIPO_TRACCIA);
                            if (brushedDateRange) {
                                relevantEdges = relevantEdges.filter(e => {
                                    const edgeDate = new Date(e[NOME_PROPRIETA_DATA_LINK]);
                                    return edgeDate >= brushedDateRange[0] && edgeDate <= brushedDateRange[1];
                                });
                            }

                            relevantEdges.forEach(edge => {
                                const locationMetadata = locationNodes.nodes.find(loc => loc.id === edge.source);
                                if (!locationMetadata) return;
                                const locationFeature = geography.features.find(f => f.properties.Name === locationMetadata.Name && f.geometry.type === 'Point'); 
                                if (!locationFeature) return;
                                
                                const coords = locationFeature.geometry.coordinates;
                                const geoPoint = [coords[0], coords[1]];

                                if (d3.geoContains(clickedZoneFeature.geometry, geoPoint)) {
                                    const vesselNode = vessels.find(v => v.id === edge.target);
                                    const companyName = vesselNode ? vesselNode[NOME_PROPRIETA_COMPAGNIA] : "Unknown";
                                    const vesselName = vesselNode ? vesselNode.name : "Unknown";

                                    pingsInThisZone.push({
                                        date: new Date(edge[NOME_PROPRIETA_DATA_LINK]),
                                        company: companyName,
                                        vessel: vesselName
                                    });
                                }
                            });
                            
                            infoBox.append("h4").text("Vessels Logged in this Zone:");
                            
                            pingsInThisZone.sort((a,b) => a.date - b.date);

                            if (pingsInThisZone.length > 0) {
                                infoBox.append("p").text(`Found ${pingsInThisZone.length} pings in this zone.`);

                                const pingsByCompany = d3.group(pingsInThisZone, d => d.company);
                                
                                const sortedCompanies = Array.from(pingsByCompany.entries());
                                sortedCompanies.sort((a, b) => b[1].length - a[1].length);
                                
                                const list = infoBox.append("ul");

                                sortedCompanies.forEach(([company, pings]) => {
                                    const companyLi = list.append("li").style("margin-top", "5px");
                                    companyLi.append("strong").text(`${company || "Unknown"} (${pings.length} pings)`);
                                    
                                    const vesselsInvolved = [...new Set(pings.map(p => p.vessel))];
                                    const vesselUl = companyLi.append("ul").style("font-size", "0.9em");
                                    vesselsInvolved.forEach(vessel => {
                                        vesselUl.append("li").text(vessel);
                                    });
                                });

                            } else {
                                infoBox.append("p").text("No pings recorded in this zone (for the selected date range).");
                            }
                        }
                    });
                }
            }
        }).addTo(geographyLayer);
        map.fitBounds(geoJSONLayer.getBounds());
        
        // --- 4. Interactivity (Function Definitions) ---

        // Populates the company filter dropdown
        function populateFilter(vessels) {
            const select = d3.select("#vessel-filter");
            if (!vessels || vessels.length === 0) return;
            const companies = [...new Set(vessels.map(v => v[NOME_PROPRIETA_COMPAGNIA]).filter(c => c))];
            const southSeafood = "SouthSeafood Express Corp";
            const otherCompanies = companies.filter(c => c !== southSeafood).sort((a, b) => a.localeCompare(b)); 
            const sortedCompanies = [southSeafood, ...otherCompanies];
            select.selectAll("option.dynamic").remove();
            select.selectAll("option.dynamic")
                .data(sortedCompanies)
                .enter().append("option")
                .attr("class", "dynamic") 
                .attr("value", d => d)
                .text(d => d);
        }
        
        // Updates the 'Selected Details' panel
        function updateDetailsPanel(entity, suspiciousPingsList = []) {
            const infoBox = d3.select("#info-box");
            infoBox.html(""); 
            
            const isVessel = entity.name && entity.name.indexOf("All ") !== 0; 
            
            infoBox.append("h4").text(isVessel ? "Selected Vessel:" : "Selected Company:");
            infoBox.append("p").text(entity.name || "Unknown Name");
            
            if (isVessel) {
                infoBox.append("h4").text("Company:");
                infoBox.append("p").text(entity[NOME_PROPRIETA_COMPAGNIA] || "Unknown");
            }
            
            infoBox.append("h4").text("Suspicious Pings Logged (in Zones):");
            
            suspiciousPingsList.sort((a,b) => a.date - b.date);

            if (suspiciousPingsList.length > 0) {
                infoBox.append("p").text(`Found ${suspiciousPingsList.length} pings in forbidden zones.`);
                const list = infoBox.append("ul");
                suspiciousPingsList.forEach(ping => {
                    list.append("li").text(`Date: ${ping.date.toLocaleString('en-US')} | Zone: ${ping.zone}`);
                });
            } else {
                infoBox.append("p").text("No pings in forbidden zones logged.");
            }
             infoBox.append("p").style("margin-top", "10px").style("font-style", "italic")
                .text("Note: Transponder gaps (dashed lines on map) are also considered suspicious behavior.");
        }
        
        // Calculates suspicious ping data for graphs
        function calculateSuspicionData(filterCompany = 'all', dateRange = null) {
            let relevantEdges = edges.filter(e => e.type === NOME_TIPO_TRACCIA);
            if (dateRange) {
                relevantEdges = relevantEdges.filter(e => {
                    const edgeDate = new Date(e[NOME_PROPRIETA_DATA_LINK]);
                    return edgeDate >= dateRange[0] && edgeDate <= dateRange[1];
                });
            }
            const companyTotals = new Map(); 
            const zoneTotals = new Map(); 
            const flows = new Map(); 
            const vesselsToScan = (filterCompany === 'all') ? vessels : vessels.filter(v => v[NOME_PROPRIETA_COMPAGNIA] === filterCompany);
            
            vesselsToScan.forEach(vessel => {
                const companyName = vessel[NOME_PROPRIETA_COMPAGNIA];
                if (!companyName) return; 
                const vesselEdges = relevantEdges.filter(e => e.target === vessel.id);
                
                vesselEdges.forEach(edge => {
                    const locationMetadata = locationNodes.nodes.find(loc => loc.id === edge.source);
                    if (!locationMetadata) return;
                    const locationFeature = geography.features.find(f => f.properties.Name === locationMetadata.Name && f.geometry.type === 'Point'); 
                    if (!locationFeature) return;
                    const coords = locationFeature.geometry.coordinates;
                    const geoPoint = [coords[0], coords[1]];
                    
                    for (const zone of forbiddenZones) {
                        if (d3.geoContains(zone.geometry, geoPoint)) {
                            const zoneName = "Forbidden zone"; 
                            
                            companyTotals.set(companyName, (companyTotals.get(companyName) || 0) + 1);
                            zoneTotals.set(zoneName, (zoneTotals.get(zoneName) || 0) + 1);
                            
                            const key = `${companyName}|${zoneName}`;
                            flows.set(key, (flows.get(key) || 0) + 1);
                            
                            break; 
                        }
                    }
                });
            });
            const sortedCompanyTotals = Array.from(companyTotals.entries()).sort((a, b) => b[1] - a[1]);
            return { sortedCompanyTotals, zoneTotals, flows };
        }
        
        // Draws the force-directed graph (suspicion network)
        function drawForceGraph(suspicionData, filterCompany = 'all') {
            const chartContainer = d3.select("#force-graph-container");
            chartContainer.html(""); 
            
            const topN = d3.select("#top-n-input").property("valueAsNumber");
            chartContainer.append("h3").attr("id", "force-graph-title").text(`Suspicious Activity Network (Top ${topN})`);
            if(filterCompany !== 'all') {
                chartContainer.select("h3").text(`Activity Network: ${filterCompany}`);
            }

            let topCompanies;
            if (filterCompany !== 'all') {
                topCompanies = suspicionData.sortedCompanyTotals.filter(d => d[0] === filterCompany);
            } else {
                topCompanies = suspicionData.sortedCompanyTotals.slice(0, topN); 
                const sse = "SouthSeafood Express Corp";
                if (!topCompanies.find(d => d[0] === sse) && suspicionData.sortedCompanyTotals.find(d => d[0] === sse)) {
                    topCompanies.push(suspicionData.sortedCompanyTotals.find(d => d[0] === sse));
                }
            }
            const topCompanyNames = new Set(topCompanies.map(d => d[0]));
            
            const nodeMap = new Map();
            suspicionData.flows.forEach((value, key) => {
                const [companyName, zoneName] = key.split('|');
                if (topCompanyNames.has(companyName)) {
                    if (!nodeMap.has(companyName)) nodeMap.set(companyName, { id: companyName, type: 'company' });
                    if (!nodeMap.has(zoneName)) nodeMap.set(zoneName, { id: zoneName, type: 'zone' });
                }
            });

            const graph = {
                nodes: Array.from(nodeMap.values()),
                links: Array.from(suspicionData.flows, ([key, value]) => {
                    const [source, target] = key.split('|');
                    return { source: source, target: target, value: value };
                }).filter(l => topCompanyNames.has(l.source)) 
            };
            
            const margin = {top: 10, right: 10, bottom: 10, left: 10};
            
            const containerNode = chartContainer.node();
            const containerHeight = containerNode.clientHeight;
            const containerWidth = containerNode.clientWidth;

            const height = Math.max(containerHeight - 40, 150); 
            const width = Math.max(containerWidth, 150);
            
            const svg = chartContainer.append("svg")
                .attr("viewBox", `0 0 ${width} ${height}`)
                .attr("preserveAspectRatio", "xMidYMid meet")
              .append("g");
            
            if (graph.nodes.length === 0) {
                 svg.append("text").text("No suspicious pings for this selection.").attr("x", width/2).attr("y", height/2).style("fill", "#666").style("text-anchor", "middle");
                return;
            }
            
            const color = (d) => {
                if (d.id === 'SouthSeafood Express Corp') return '#dc3545';
                if (d.type === 'company') return '#FFA500';
                return '#6c757d';
            };

            const allCompanyPings = suspicionData.sortedCompanyTotals.map(d => d[1]);
            const allZonePings = Array.from(suspicionData.zoneTotals.values());
            const maxPings = d3.max([...allCompanyPings, ...allZonePings]) || 1;

            const nodeRadiusScale = d3.scaleSqrt()
                .domain([1, maxPings])
                .range([6, 25]); 

            // Helper: Get node radius based on ping count
            function getNodeRadius(d) {
                let pings = 1;
                if (d.type === 'company') {
                    const companyData = suspicionData.sortedCompanyTotals.find(c => c[0] === d.id);
                    pings = companyData ? companyData[1] : 1;
                } else { // 'zone'
                    pings = suspicionData.zoneTotals.get(d.id) || 1;
                }
                return nodeRadiusScale(pings);
            }

            const linkOpacityScale = d3.scaleSqrt()
                .domain([1, d3.max(graph.links, d => d.value) || 1])
                .range([0.2, 0.9]);

            const simulation = d3.forceSimulation(graph.nodes)
                .force("link", d3.forceLink(graph.links).id(d => d.id).distance(150))
                .force("charge", d3.forceManyBody().strength(-800))
                .force("collide", d3.forceCollide().radius(d => getNodeRadius(d) + 3)) 
                .force("center", d3.forceCenter(width / 2, height / 2)); 

            const linkedByIndex = {};
            graph.links.forEach(d => {
                linkedByIndex[`${d.source.id},${d.target.id}`] = 1;
            });

            // Helper: Check if two nodes are linked
            function isConnected(a, b) {
                return linkedByIndex[`${a.id},${b.id}`] || linkedByIndex[`${b.id},${a.id}`] || a.id === b.id;
            }
            
            // Helper: Fade graph elements for hover
            function fadeOut() {
                node.style("opacity", 0.1);
                text.style("opacity", 0.1);
                link.style("stroke-opacity", 0.05);
            }
            
            // Helper: Reset graph opacity after hover
            function resetOpacity() {
                node.style("opacity", 1);
                text.style("opacity", 1);
                link.style("stroke-opacity", d => linkOpacityScale(d.value)) 
                    .style("stroke", d => d.source.id === 'SouthSeafood Express Corp' ? '#dc3545' : '#969696'); 
            }
            
            const link = svg.append("g")
                .selectAll("line")
                .data(graph.links)
                .enter().append("line")
                .attr("class", "force-graph-link")
                .attr("stroke", d => (d.source.id === 'SouthSeafood Express Corp') ? '#dc3545' : '#969696')
                .attr("stroke-width", 2) 
                .attr("stroke-opacity", d => linkOpacityScale(d.value)) 
                .style("cursor", "pointer")
                .on("click", (event, d) => {
                    d3.select("#vessel-filter").property("value", d.source.id);
                    updateDashboard(false);
                })
                .on("mouseover", (event, d) => {
                    tooltip.transition().duration(200).style("opacity", .9);
                    tooltip.html(`<b>Flow:</b> ${d.source.id} → ${d.target.id}<br><b>Pings:</b> ${d.value}`)
                        .style("left", (event.pageX + 10) + "px")
                        .style("top", (event.pageY - 28) + "px");
                })
                .on("mousemove", (event) => {
                    tooltip.style("left", (event.pageX + 10) + "px").style("top", (event.pageY - 28) + "px");
                })
                .on("mouseout", () => {
                    tooltip.transition().duration(500).style("opacity", 0);
                });

            const symbolGenerator = d3.symbol()
                .type(d3.symbolCircle)
                .size(d => Math.PI * Math.pow(getNodeRadius(d), 2)); 

            const node = svg.append("g")
                .selectAll("path") 
                .data(graph.nodes)
                .enter().append("path") 
                .attr("class", "force-graph-node")
                .attr("d", symbolGenerator) 
                .attr("fill", color)
                .call(drag(simulation))
                .on("click", (event, d) => {
                    if (d.type === 'company') {
                        d3.select("#vessel-filter").property("value", d.id);
                        updateDashboard(false);
                    }
                })
                .on("mouseover", (event, d) => {
                    tooltip.transition().duration(200).style("opacity", .9);

                    let tooltipHtml = "";
                    if (d.type === 'company') {
                        const totalPingsEntry = suspicionData.sortedCompanyTotals.find(c => c[0] === d.id);
                        const totalPings = totalPingsEntry ? totalPingsEntry[1] : 0;
                        tooltipHtml = `<b>Company</b><br>${d.id}<br><b>Total Pings: ${totalPings}</b>`;

                    } else {
                        tooltipHtml = `<b>Zone</b><br>${d.id}<br><b>Total Pings:</b> ${suspicionData.zoneTotals.get(d.id)}`;
                    }

                    tooltip.html(tooltipHtml)
                        .style("left", (event.pageX + 10) + "px")
                        .style("top", (event.pageY - 28) + "px");
                        
                    fadeOut();
                    
                    node.filter(n => isConnected(d, n))
                        .style("opacity", 1);
                        
                    text.filter(t => isConnected(d, t))
                        .style("opacity", 1);
                        
                    link.filter(l => l.source.id === d.id || l.target.id === d.id)
                        .style("stroke-opacity", 0.9)
                        .style("stroke", l => l.source.id === 'SouthSeafood Express Corp' ? '#dc3545' : '#FFA500');
                })
                .on("mousemove", (event) => {
                    tooltip.style("left", (event.pageX + 10) + "px").style("top", (event.pageY - 28) + "px");
                })
                .on("mouseout", () => {
                    tooltip.transition().duration(500).style("opacity", 0);
                    resetOpacity();
                });

            const text = svg.append("g")
                .selectAll("text")
                .data(graph.nodes)
                .enter().append("text")
                .attr("class", "force-graph-text")
                .attr("text-anchor", "middle")
                .attr("dy", d => `-${getNodeRadius(d) + 5}px`) 
                .text(d => d.id);
            
            simulation.on("tick", () => {
                graph.nodes.forEach(d => {
                    d.x = Math.max(10, Math.min(width - 10, d.x));
                    d.y = Math.max(10, Math.min(height - 10, d.y));
                });
                
                link
                    .attr("x1", d => d.source.x)
                    .attr("y1", d => d.source.y)
                    .attr("x2", d => d.target.x)
                    .attr("y2", d => d.target.y);
                node
                    .attr("transform", d => `translate(${d.x},${d.y})`);
                text
                    .attr("x", d => d.x)
                    .attr("y", d => d.y);
            });

            // Enables drag behavior for graph nodes
            function drag(simulation) {
                function dragstarted(event, d) {
                    if (!event.active) simulation.alphaTarget(0.3).restart();
                    d.fx = d.x;
                    d.fy = d.y;
                }
                function dragged(event, d) {
                    d.fx = event.x;
                    d.fy = event.y;
                }
                function dragended(event, d) {
                    if (!event.active) simulation.alphaTarget(0);
                }
                return d3.drag()
                    .on("start", dragstarted)
                    .on("drag", dragged)
                    .on("end", dragended);
            }
        }
        
        // Draws the timeline area chart
        function drawTimelineChart(filterCompany = 'all') {
            const chartContainer = d3.select("#timeline-chart-container");
            chartContainer.html(""); 
            let dataForChart, yAxisLabel, title, titleColor;
            if (filterCompany === 'all') {
                title = "Total Cargo Over Time (All Companies)";
                yAxisLabel = "Total Cargo Quantity (Tons)";
                titleColor = "#007bff";
                const dailyData = d3.group(allPortExitData, d => d3.timeDay.floor(d.date));
                dataForChart = Array.from(dailyData, ([date, values]) => ({ date: date, value: d3.sum(values, d => d.quantity) }));
            } else {
                title = `Suspicious Pings: ${filterCompany}`;
                yAxisLabel = "Number of Suspicious Pings";
                titleColor = (filterCompany === 'SouthSeafood Express Corp') ? '#dc3545' : '#FFA500';
                let suspiciousPings = [];
                const companyVessels = vessels.filter(v => v[NOME_PROPRIETA_COMPAGNIA] === filterCompany);
                companyVessels.forEach(vessel => {
                    const vesselEdges = edges.filter(e => e.target === vessel.id && e.type === NOME_TIPO_TRACCIA);
                    vesselEdges.forEach(edge => {
                        const locationMetadata = locationNodes.nodes.find(loc => loc.id === edge.source);
                        if (!locationMetadata) return;
                        const locationFeature = geography.features.find(f => f.properties.Name === locationMetadata.Name && f.geometry.type === 'Point'); 
                        if (!locationFeature) return;
                        const coords = locationFeature.geometry.coordinates;
                        const geoPoint = [coords[0], coords[1]];
                        for (const zone of forbiddenZones) {
                            if (d3.geoContains(zone.geometry, geoPoint)) {
                                suspiciousPings.push({ date: new Date(edge[NOME_PROPRIETA_DATA_LINK]) });
                                break; 
                            }
                        }
                    });
                });
                const dailyData = d3.group(suspiciousPings, d => d3.timeDay.floor(d.date));
                dataForChart = Array.from(dailyData, ([date, values]) => ({ date: date, value: values.length }));
            }
            chartContainer.append("h3").text(title);
            dataForChart.sort((a, b) => a.date - b.date); 
            const margin = {top: 10, right: 30, bottom: 30, left: 60};
            const containerNode = chartContainer.node();
            const containerHeight = containerNode.clientHeight;
            const containerWidth = containerNode.clientWidth;
            const height = Math.max(containerHeight - 40 - margin.top - margin.bottom, 100); 
            const width = Math.max(containerWidth - margin.left - margin.right, 100);
            const svg = chartContainer.append("svg").attr("viewBox", `0 0 ${containerWidth} ${containerHeight}`).append("g").attr("transform", `translate(${margin.left},${margin.top})`);
            timelineSvg = svg; 
            if (dataForChart.length === 0) {
                 svg.append("text").text("No data for this period.").attr("x", width/2).attr("y", height/2).style("fill", "#666").style("text-anchor", "middle");
                return;
            }
            const xScale = d3.scaleTime().domain(d3.extent(dataForChart, d => d.date)).range([0, width]);
            const yScale = d3.scaleLinear().domain([0, d3.max(dataForChart, d => d.value) || 1]).range([height, 0]);
            timelineXScale = xScale;
            timelineHeight = height;
            svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(xScale).ticks(5).tickFormat(d3.timeFormat("%Y-%m")));
            svg.append("g").call(d3.axisLeft(yScale).ticks(5));
            svg.append("text").attr("transform", "rotate(-90)").attr("y", 0 - margin.left + 15).attr("x", 0 - (height / 2)).attr("dy", "1em").style("text-anchor", "middle").style("font-size", "12px").text(yAxisLabel);
            const areaGenerator = d3.area().x(d => xScale(d.date)).y0(height).y1(d => yScale(d.value));
            svg.append("path").datum(dataForChart).attr("fill", titleColor).attr("fill-opacity", 0.7).attr("stroke", d3.rgb(titleColor).darker(1)).attr("stroke-width", 1.5).attr("d", areaGenerator);
            const highlightGroup = svg.append("g").attr("class", "date-range-highlight");
            
            // Handles timeline brush (date selection) event
            function onBrushEnd(event) {
                const selection = event.selection;
                if (selection) {
                    brushedDateRange = [ xScale.invert(selection[0]), xScale.invert(selection[1]) ];

                    const toLocalISODate = (date) => {
                        const year = date.getFullYear();
                        const month = (date.getMonth() + 1).toString().padStart(2, '0');
                        const day = date.getDate().toString().padStart(2, '0');
                        return `${year}-${month}-${day}`;
                    };

                    d3.select("#start-date").property("value", toLocalISODate(brushedDateRange[0]));
                    d3.select("#end-date").property("value", toLocalISODate(brushedDateRange[1]));

                } else {
                    brushedDateRange = null; 
                    d3.select("#start-date").property("value", "");
                    d3.select("#end-date").property("value", "");
                }
                if (event.sourceEvent) {
                    updateDashboard(false); 
                }
                updateDateRangeHighlight();
            }
            chartBrush = d3.brushX().extent([[0, 0], [width, height]]).on("end", onBrushEnd); 
            svg.append("g").attr("class", "brush").call(chartBrush);
            updateDateRangeHighlight();
            const bisector = d3.bisector(d => d.date).left;
            const focus = svg.append("g").attr("class", "focus").style("display", "none");
            focus.append("line").attr("class", "focus-line").attr("y1", 0).attr("y2", height).attr("stroke", "#666").attr("stroke-width", 1).attr("stroke-dasharray", "3,3");
            focus.append("circle").attr("r", 5).attr("fill", "white").attr("stroke", "black").attr("stroke-width", 1.5);
            svg.append("rect").attr("width", width).attr("height", height).style("fill", "none").style("pointer-events", "all")
                .on("mouseout", () => { focus.style("display", "none"); tooltip.style("opacity", 0); })
                .on("mouseover", () => { focus.style("display", null); tooltip.style("opacity", .9); })
                .on("mousemove", (event) => {
                    const x0 = xScale.invert(d3.pointer(event)[0]); 
                    const i = bisector(dataForChart, x0, 1); 
                    const d0 = dataForChart[i - 1];
                    const d1 = dataForChart[i];
                    const d = (d1 && (d0 ? (x0 - d0.date > d1.date - x0) : true)) ? d1 : d0;
                    if (d) {
                        focus.attr("transform", `translate(${xScale(d.date)},0)`);
                        focus.select("circle").attr("transform", `translate(0,${yScale(d.value)})`);
                        tooltip.html(`<b>${d.date.toLocaleDateString('en-US')}</b><br>${yAxisLabel}: ${d.value.toFixed(0)}`).style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");
                    }
                });
        }
        
        // Shows/hides red date lines on timeline
        function updateDateRangeHighlight() {
            if (!timelineSvg || !timelineXScale || !timelineHeight) return;
            const highlightGroup = timelineSvg.select(".date-range-highlight");
            highlightGroup.selectAll("*").remove(); 
            if (brushedDateRange) {
                const x1 = timelineXScale(brushedDateRange[0]);
                const x2 = timelineXScale(brushedDateRange[1]);
                highlightGroup.append("line").attr("x1", x1).attr("x2", x1).attr("y1", 0).attr("y2", timelineHeight).attr("stroke", "red").attr("stroke-width", 2).attr("stroke-dasharray", "5,3");
                highlightGroup.append("line").attr("x1", x2).attr("x2", x2).attr("y1", 0).attr("y2", timelineHeight).attr("stroke", "red").attr("stroke-width", 2).attr("stroke-dasharray", "5,3");
            }
        }

        // Draws vessel polylines on the Leaflet map
        function drawVesselTracks(companiesToShow) { 
            vesselTracksLayer.clearLayers();
            
            const GAP_THRESHOLD_HOURS = 12; 
            
            const filteredVessels = vessels.filter(v => 
                companiesToShow.has(v[NOME_PROPRIETA_COMPAGNIA])
            );
            
            filteredVessels.forEach(vessel => {
                const vesselEdges = edges.filter(e => 
                    e.target === vessel.id && e.type === NOME_TIPO_TRACCIA
                );
                
                let filteredEdges = vesselEdges;
                if (brushedDateRange) {
                    filteredEdges = filteredEdges.filter(e => {
                        const edgeDate = new Date(e[NOME_PROPRIETA_DATA_LINK]);
                        return edgeDate >= brushedDateRange[0] && edgeDate <= brushedDateRange[1];
                    });
                }
                
                if (filteredEdges.length === 0) return; 

                filteredEdges.sort((a, b) => new Date(a[NOME_PROPRIETA_DATA_LINK]) - new Date(b[NOME_PROPRIETA_DATA_LINK]));
                
                const suspiciousPingsForThisVessel = [];
                
                let currentTrackSegment = [];
                let lastPingTime = null;

                for (const edge of filteredEdges) {
                    const locationMetadata = locationNodes.nodes.find(loc => loc.id === edge.source);
                    if (!locationMetadata) continue;
                    const locationFeature = geography.features.find(f => 
                        f.properties.Name === locationMetadata.Name && f.geometry.type === 'Point'
                    ); 
                    if (!locationFeature) continue;

                    const coords = locationFeature.geometry.coordinates;
                    const geoPoint = [coords[0], coords[1]]; 
                    const pointForLeaflet = [coords[1], coords[0]]; 
                    const currentPingTime = new Date(edge[NOME_PROPRIETA_DATA_LINK]);

                    let foundZones = [];
                    for (const zone of forbiddenZones) {
                        if (d3.geoContains(zone.geometry, geoPoint)) {
                            foundZones.push(zone.properties.Name || "Forbidden Zone");
                        }
                    }
                    
                    if (foundZones.length > 0) {
                         suspiciousPingsForThisVessel.push({
                            date: currentPingTime,
                            zone: foundZones.join(', ') 
                        });
                    }
                    
                    if (lastPingTime) {
                        const hoursDiff = (currentPingTime - lastPingTime) / (1000 * 60 * 60);
                        
                        if (hoursDiff > GAP_THRESHOLD_HOURS) {
                            drawTrackSegment(vessel, currentTrackSegment, suspiciousPingsForThisVessel);
                            
                            const lastPoint = currentTrackSegment[currentTrackSegment.length - 1];
                            if (lastPoint) { 
                                L.polyline([lastPoint, pointForLeaflet], {
                                    color: '#222222', 
                                    weight: 2,
                                    opacity: 0.7,
                                    dashArray: '5, 10' 
                                }).addTo(vesselTracksLayer)
                                .bindPopup(`<b>Transponder Gap</b><br>${vessel.name}<br>${hoursDiff.toFixed(1)} hours`);
                            }
                            currentTrackSegment = [pointForLeaflet];
                        } else {
                            currentTrackSegment.push(pointForLeaflet);
                        }
                    } else {
                        currentTrackSegment.push(pointForLeaflet);
                    }
                    lastPingTime = currentPingTime;
                }
                
                drawTrackSegment(vessel, currentTrackSegment, suspiciousPingsForThisVessel);
            });

            // Helper: Draws a single track segment
            function drawTrackSegment(vessel, coordinates, suspiciousPingsList) {
                if (coordinates.length < 2) return;

                let trackColor = '#007bff'; 
                let trackWeight = 2;
                let trackOpacity = 0.7;
                
                if (vessel[NOME_PROPRIETA_COMPAGNIA] === 'SouthSeafood Express Corp') {
                    trackColor = '#dc3545'; 
                    trackWeight = 3;
                    trackOpacity = 0.8;
                } else if (suspiciousPingsList.length > 0) {
                    trackColor = '#FFA500'; 
                    trackWeight = 3;
                    trackOpacity = 0.8;
                }

                L.polyline(coordinates, { 
                    color: trackColor, weight: trackWeight, opacity: trackOpacity
                })
                .addTo(vesselTracksLayer)
                .bindPopup(`<b>Vessel:</b> ${vessel.name}<br><b>Company:</b> ${vessel[NOME_PROPRIETA_COMPAGNIA]}`)
                .on("click", (e) => {
                    const companyName = vessel[NOME_PROPRIETA_COMPAGNIA];

                    if (companyName) {
                        d3.select("#vessel-filter").property("value", companyName);
                        updateDashboard(false); 
                    } else {
                        updateDetailsPanel(vessel, suspiciousPingsList);
                    }
                    
                    L.DomEvent.stopPropagation(e); 
                })
                .on('mouseover', function(e) { this.setStyle({ weight: 5, opacity: 1 }); })
                .on('mouseout', function(e) { this.setStyle({ weight: trackWeight, opacity: trackOpacity }); });
            }
        }
        
        // Populates the vessel filter
        populateFilter(vessels); 

        // Main function to update all visualizations
        function updateAllCharts(companyName) {
            const suspicionData = calculateSuspicionData(companyName, brushedDateRange);
            const topN = d3.select("#top-n-input").property("valueAsNumber");

            let companiesToShow;
            if (companyName !== 'all') {
                companiesToShow = new Set([companyName]);
            } else {
                let topCompanies = suspicionData.sortedCompanyTotals.slice(0, topN);
                const sse = "SouthSeafood Express Corp";
                if (!topCompanies.find(d => d[0] === sse) && suspicionData.sortedCompanyTotals.find(d => d[0] === sse)) {
                    topCompanies.push(suspicionData.sortedCompanyTotals.find(d => d[0] === sse));
                }
                companiesToShow = new Set(topCompanies.map(d => d[0]));
            }
            
            drawVesselTracks(companiesToShow); 
            drawForceGraph(suspicionData, companyName);
            drawTimelineChart(companyName); 
        }

        // Updates charts and info panel based on filters
        function updateDashboard(resetBrush = false) {
            const currentCompany = d3.select("#vessel-filter").property("value");
            
            if (currentCompany !== 'all') {
                const companyVessels = vessels.filter(v => v[NOME_PROPRIETA_COMPAGNIA] === currentCompany);
                let allSuspiciousPings = [];
                companyVessels.forEach(vessel => {
                    let relevantEdges = edges.filter(e => e.target === vessel.id && e.type === NOME_TIPO_TRACCIA);
                    if (brushedDateRange) {
                        relevantEdges = relevantEdges.filter(e => {
                            const edgeDate = new Date(e[NOME_PROPRIETA_DATA_LINK]);
                            return edgeDate >= brushedDateRange[0] && edgeDate <= brushedDateRange[1];
                        });
                    }
                    relevantEdges.forEach(edge => {
                           const locationMetadata = locationNodes.nodes.find(loc => loc.id === edge.source);
                           if (!locationMetadata) return;
                           const locationFeature = geography.features.find(f => f.properties.Name === locationMetadata.Name && f.geometry.type === 'Point'); 
                           if (!locationFeature) return;
                           const coords = locationFeature.geometry.coordinates;
                           const geoPoint = [coords[0], coords[1]];

                            let foundZones = [];
                            for (const zone of forbiddenZones) {
                                if (d3.geoContains(zone.geometry, geoPoint)) {
                                    foundZones.push(zone.properties.Name || "Forbidden Zone");
                                }
                            }
                            
                            if (foundZones.length > 0) {
                                allSuspiciousPings.push({
                                    date: new Date(edge[NOME_PROPRIETA_DATA_LINK]),
                                    zone: foundZones.join(', ') 
                                });
                            }
                    });
                });
                updateDetailsPanel({ name: `All ${currentCompany} Vessels`, [NOME_PROPRIETA_COMPAGNIA]: currentCompany }, allSuspiciousPings);

            } else {
                d3.select("#info-box").html("<p>Click on a map track or a graph node for details.</p>");
            }
            
            updateAllCharts(currentCompany);
            
            if (resetBrush && timelineSvg && chartBrush) {
                timelineSvg.select(".brush").call(chartBrush.move, null);
            }
        }

        // --- Control Listeners ---
        
        d3.select("#vessel-filter").on("change", () => updateDashboard(false));
        d3.select("#top-n-input").on("change", () => updateDashboard(false));
        
        d3.select("#company-search").on("input", function() {
            const searchText = this.value.toLowerCase();
            const selectElement = d3.select("#vessel-filter").node();
            const matchedOption = Array.from(selectElement.options).find(opt => opt.value !== 'all' && opt.value.toLowerCase().includes(searchText));
            if (matchedOption) {
                selectElement.value = matchedOption.value;
                selectElement.dispatchEvent(new Event('change'));
            } else if (searchText === "") {
                 selectElement.value = 'all';
                 selectElement.dispatchEvent(new Event('change'));
            }
        });
        d3.select("#filter-date-button").on("click", () => {
            const startDate = d3.select("#start-date").property("value");
            const endDate = d3.select("#end-date").property("value");
            if (startDate && endDate) {
                brushedDateRange = [ new Date(startDate + "T00:00:00"), new Date(endDate + "T23:59:59") ];
                console.log("Manual date filter applied:", brushedDateRange);
                updateDashboard(false); 
                updateDateRangeHighlight();
                if (timelineSvg && chartBrush && timelineXScale) {
                    const selectionPixels = [ timelineXScale(brushedDateRange[0]), timelineXScale(brushedDateRange[1]) ];
                    timelineSvg.select(".brush").call(chartBrush.move, selectionPixels);
                }
            } else {
                console.warn("Please select both a start and end date.");
            }
        });
        d3.select("#reset-button").on("click", () => {
            d3.select("#vessel-filter").property("value", "all");
            brushedDateRange = null; 
            d3.select("#company-search").property("value", "");
            d3.select("#start-date").property("value", "");
            d3.select("#end-date").property("value", "");
            d3.select("#top-n-input").property("value", 10);
            map.fitBounds(geoJSONLayer.getBounds());
            updateDashboard(true); 
            updateDateRangeHighlight();
        });
        
        // Resize handler (debounced)
        d3.select(window).on("resize", debounce(() => {
            const currentCompany = d3.select("#vessel-filter").property("value");
            updateAllCharts(currentCompany);
        }, 250));
        
        // Initial dashboard load
        setTimeout(() => {
            updateDashboard(true);
        }, 10);

    }).catch(error => {
        console.error("CRITICAL ERROR:", error);
        d3.select("#dashboard").html(`<h2>Error loading data.</h2><p>Check the console for details.</p><p><i>${error.message}</i></p>`);
    });
});
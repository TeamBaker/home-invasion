// Simple test to verify occlusion setup
import * as THREE from 'three';
import { RoomSense } from './js/room.js';

// Create a simple test
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(800, 600);
renderer.setClearColor(0x222222);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 100);
camera.position.set(0, 2, 5);

// Create a dolly (like in main.js)
const dolly = new THREE.Group();
scene.add(dolly);

// Create room sense
const room = new RoomSense(dolly);

// Load simulated room
room.loadSim();

// Add a test object that should be occluded
const testGeometry = new THREE.SphereGeometry(0.5, 16, 16);
const testMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
const testObject = new THREE.Mesh(testGeometry, testMaterial);
testObject.position.set(0, 1, -3); // Behind where walls should be
scene.add(testObject);

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  
  // Update room (this should trigger occluder creation)
  room.update(0.016, { x: 0, z: 0 });
  
  renderer.render(scene, camera);
}

animate();

console.log('Occlusion test running. Check browser console for occluder creation messages.');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const { packToFs } = require('ipfs-car/pack/fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const EventEmitter = require('events');

const app = express();
const PORT = 8020;

// Event emitter for progress tracking
const uploadEvents = new EventEmitter();

// CORS Configuration
const corsOptions = {
  origin: [''],
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-id', 'x-chunk-index', 'x-total-chunks'],
  credentials: true,
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Session management
const uploadSessions = new Map();

// Base directory setup
const baseDir = path.join(process.cwd(), 'assetsfolder');
fs.ensureDirSync(baseDir);

// S3 Client Configuration
const s3 = new S3Client({
  endpoint: 'https://s3.filebase.com',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'A48CAC64950102A937C2',
    secretAccessKey: 'd3TAsDywR9xH5eW6TaoYJsgJXbvFutfytPIRzdtD',
  },
});

const bucketName = 'koirengrilso';
let lastRootCID = null;

// Utility Functions
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

const getNextFolderNumber = () => {
  let maxNumber = 0;
  const folders = fs.readdirSync(baseDir).filter((file) => {
    return fs.statSync(path.join(baseDir, file)).isDirectory();
  });

  folders.forEach((folder) => {
    const number = parseInt(folder, 10);
    if (!isNaN(number) && number > maxNumber) {
      maxNumber = number;
    }
  });

  return maxNumber + 1;
};

const getFileExtension = (fileName, folderPath) => {
  const validExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
  for (const ext of validExtensions) {
    if (fs.existsSync(path.join(folderPath, `${fileName}${ext}`))) {
      return ext;
    }
  }
  return '.png';
};

// Progress tracking for CAR file creation
const createCarFile = async (folderPath, outputCarPath, sessionId, fileType) => {
  try {
    uploadEvents.emit('progress', {
      sessionId,
      fileType,
      stage: 'packaging',
      message: 'Starting CAR file creation'
    });

    const { root } = await packToFs({
      input: folderPath,
      output: outputCarPath,
      wrapWithDirectory: false,
    });

    lastRootCID = root;
    
    uploadEvents.emit('progress', {
      sessionId,
      fileType,
      stage: 'packaging',
      message: 'CAR file creation complete',
      rootCID: root
    });

    console.log(`CAR file created successfully. Root CID: ${root}`);
    return { carFilePath: outputCarPath, rootCID: root };
  } catch (error) {
    console.error('Error creating CAR file:', error);
    throw error;
  }
};

// Enhanced upload function with progress tracking
const uploadCarFile = async (carFilePath, sessionId, fileType) => {
  try {
    const fileStream = fs.createReadStream(carFilePath);
    const fileSize = fs.statSync(carFilePath).size;
    const startTime = Date.now();
    let lastLoaded = 0;
    
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucketName,
        Key: path.basename(carFilePath),
        Body: fileStream,
        Metadata: { import: 'car' },
      },
    });

    upload.on('httpUploadProgress', (progress) => {
      const currentTime = Date.now();
      const loaded = progress.loaded || 0;
      const total = fileSize;
      const percentage = ((loaded / total) * 100).toFixed(2);
      
      // Calculate upload speed
      const timeElapsed = (currentTime - startTime) / 1000; // in seconds
      const uploadSpeed = loaded / timeElapsed; // bytes per second
      
      // Calculate remaining time
      const remaining = total - loaded;
      const estimatedTimeRemaining = remaining / uploadSpeed; // seconds
      
      // Calculate current chunk speed
      const chunkSize = loaded - lastLoaded;
      const chunkSpeed = chunkSize / 1; // bytes per second for last chunk
      
      lastLoaded = loaded;
      
      const progressData = {
        sessionId,
        fileType,
        stage: 'uploading',
        loaded: formatBytes(loaded),
        total: formatBytes(total),
        percentage,
        speed: formatBytes(uploadSpeed) + '/s',
        estimatedTimeRemaining: Math.ceil(estimatedTimeRemaining),
        currentSpeed: formatBytes(chunkSpeed) + '/s'
      };
      
      uploadEvents.emit('progress', progressData);
    });

    const response = await upload.done();
    
    uploadEvents.emit('progress', {
      sessionId,
      fileType,
      stage: 'complete',
      message: 'Upload complete',
      ETag: response.ETag
    });

    console.log(`CAR file uploaded successfully. ETag: ${response.ETag}`);
    return response;
  } catch (error) {
    console.error('Error uploading CAR file:', error);
    uploadEvents.emit('progress', {
      sessionId,
      fileType,
      stage: 'error',
      message: error.message
    });
    throw error;
  } finally {
    if (fs.existsSync(carFilePath)) {
      fs.unlinkSync(carFilePath);
    }
  }
};

// Metadata Processing with progress updates
const updateMetadataFiles = async (metadataFolderPath, rootCID, sessionId) => {
  try {
    const files = fs.readdirSync(metadataFolderPath).filter(file => file.endsWith('.json'));
    const totalFiles = files.length;
    
    uploadEvents.emit('progress', {
      sessionId,
      fileType: 'metadata',
      stage: 'processing',
      message: `Processing ${totalFiles} metadata files`,
      totalFiles
    });

    for (const [index, file] of files.entries()) {
      const filePath = path.join(metadataFolderPath, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const fileName = path.basename(file, '.json');
      const fileExtension = getFileExtension(fileName, path.join(metadataFolderPath, '..', 'images'));

      if (fileExtension === '.mp4') {
        data.video = `ipfs://${rootCID}/${fileName}${fileExtension}`;
      } else {
        data.image = `ipfs://${rootCID}/${fileName}${fileExtension}`;
      }

      const newFilePath = path.join(metadataFolderPath, fileName);
      fs.writeFileSync(newFilePath, JSON.stringify(data, null, 2), 'utf-8');
      
      uploadEvents.emit('progress', {
        sessionId,
        fileType: 'metadata',
        stage: 'processing',
        processedFiles: index + 1,
        totalFiles,
        percentage: ((index + 1) / totalFiles * 100).toFixed(2)
      });

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    uploadEvents.emit('progress', {
      sessionId,
      fileType: 'metadata',
      stage: 'processing',
      message: 'Metadata processing complete',
      processedFiles: totalFiles,
      totalFiles
    });
  } catch (error) {
    console.error('Error updating metadata files:', error);
    uploadEvents.emit('progress', {
      sessionId,
      fileType: 'metadata',
      stage: 'error',
      message: error.message
    });
    throw error;
  }
};

// File Upload Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.headers['x-session-id'];
    const chunkIndex = req.headers['x-chunk-index'];
    
    if (!uploadSessions.has(sessionId)) {
      uploadSessions.set(sessionId, {
        tempFolder: path.join(baseDir, 'temp', sessionId),
        chunks: new Set(),
        totalChunks: parseInt(req.headers['x-total-chunks']),
      });
    }

    const session = uploadSessions.get(sessionId);
    const chunkFolder = path.join(session.tempFolder, chunkIndex.toString());
    
    const imageFolder = path.join(chunkFolder, 'images');
    const metadataFolder = path.join(chunkFolder, 'metadata');
    fs.ensureDirSync(imageFolder);
    fs.ensureDirSync(metadataFolder);

    const subfolder = file.mimetype.startsWith('image/') || file.mimetype === 'video/mp4' 
      ? 'images' 
      : 'metadata';
    
    cb(null, path.join(chunkFolder, subfolder));
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit
  }
});

// Progress tracking endpoint
app.get('/upload-progress/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendProgress = (progressData) => {
    if (progressData.sessionId === sessionId) {
      res.write(`data: ${JSON.stringify(progressData)}\n\n`);
    }
  };

  uploadEvents.on('progress', sendProgress);

  req.on('close', () => {
    uploadEvents.removeListener('progress', sendProgress);
  });
});

// Enhanced chunk merging with progress tracking
async function mergeChunks(sessionId) {
  const session = uploadSessions.get(sessionId);
  const finalFolder = path.join(baseDir, getNextFolderNumber().toString());
  
  try {
    uploadEvents.emit('progress', {
      sessionId,
      stage: 'merging',
      message: 'Starting chunk merge'
    });

    const finalImagesFolder = path.join(finalFolder, 'images');
    const finalMetadataFolder = path.join(finalFolder, 'metadata');
    fs.ensureDirSync(finalImagesFolder);
    fs.ensureDirSync(finalMetadataFolder);

    let processedChunks = 0;
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkFolder = path.join(session.tempFolder, i.toString());
      
      // Merge images
      const chunkImages = path.join(chunkFolder, 'images');
      if (fs.existsSync(chunkImages)) {
        const files = fs.readdirSync(chunkImages);
        for (const file of files) {
          await fs.copy(
            path.join(chunkImages, file),
            path.join(finalImagesFolder, file)
          );
        }
      }
      
      // Merge metadata
      const chunkMetadata = path.join(chunkFolder, 'metadata');
      if (fs.existsSync(chunkMetadata)) {
        const files = fs.readdirSync(chunkMetadata);
        for (const file of files) {
          await fs.copy(
            path.join(chunkMetadata, file),
            path.join(finalMetadataFolder, file)
          );
        }
      }

      processedChunks++;
      uploadEvents.emit('progress', {
        sessionId,
        stage: 'merging',
        processedChunks,
        totalChunks: session.totalChunks,
        percentage: ((processedChunks / session.totalChunks) * 100).toFixed(2)
      });
    }

    await fs.remove(session.tempFolder);
    uploadSessions.delete(sessionId);

    uploadEvents.emit('progress', {
      sessionId,
      stage: 'merging',
      message: 'Chunk merge complete'
    });

    return finalFolder;
  } catch (error) {
    console.error('Error merging chunks:', error);
    uploadEvents.emit('progress', {
      sessionId,
      stage: 'error',
      message: error.message
    });
    throw error;
  }
}

// Main upload endpoint
app.post('/uploadfiles', (req, res) => {
  upload.any()(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(500).json({ error: 'Error uploading files.', details: err.message });
    }

    try {
      const sessionId = req.headers['x-session-id'];
      const chunkIndex = parseInt(req.headers['x-chunk-index']);
      const session = uploadSessions.get(sessionId);

      if (!session) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }

      session.chunks.add(chunkIndex);

      if (session.chunks.size < session.totalChunks) {
        return res.status(200).json({ 
          message: 'Chunk uploaded successfully',
          progress: (session.chunks.size / session.totalChunks) * 100
        });
      }

      console.log('Processing final merged folder...');
      const finalFolder = await mergeChunks(sessionId);
      
      // Process images
      const imagesFolderPath = path.join(finalFolder, 'images');
      const imagesCarPath = path.join(finalFolder, 'images.car');
      console.log('Creating images CAR file...');
      const { rootCID: imagesRootCID } = await createCarFile(imagesFolderPath, imagesCarPath, sessionId, 'images');

      console.log('Uploading images CAR file...');
      await uploadCarFile(imagesCarPath, sessionId, 'images');

      // Process metadata
      const metadataFolderPath = path.join(finalFolder, 'metadata');
      console.log('Updating metadata files...');
      await updateMetadataFiles(metadataFolderPath, imagesRootCID, sessionId);
      
      const metadataCarPath = path.join(finalFolder, 'metadata.car');
      console.log('Creating metadata CAR file...');
      const { rootCID: metadataRootCID } = await createCarFile(metadataFolderPath, metadataCarPath, sessionId, 'metadata');
      console.log('Uploading metadata CAR file...');
      await uploadCarFile(metadataCarPath, sessionId, 'metadata');

      // Cleanup
      await fs.remove(finalFolder);

      // Final success event
      uploadEvents.emit('progress', {
        sessionId,
        stage: 'complete',
        message: 'All operations completed successfully',
        imagesRootCID,
        metadataRootCID
      });

      res.status(200).json({
        success: true,
        message: 'Upload complete',
        imagesRootCID,
        metadataRootCID,
        lastRootCID: String(metadataRootCID)
      });

    } catch (error) {
      console.error('Error processing files:', error);
      
      // Emit error event
      uploadEvents.emit('progress', {
        sessionId: req.headers['x-session-id'],
        stage: 'error',
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });

      res.status(500).json({ 
        error: 'Error processing files',
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Server
const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Upload endpoint: http://localhost:${PORT}/uploadfiles`);
  console.log(`Health check endpoint: http://localhost:${PORT}/health`);
});

// Cleanup on process exit
process.on('SIGINT', async () => {
  try {
    console.log('\nReceived SIGINT. Cleaning up...');
    
    // Clean temporary folders
    const tempFolder = path.join(baseDir, 'temp');
    if (fs.existsSync(tempFolder)) {
      await fs.remove(tempFolder);
      console.log('Temporary folders cleaned up');
    }

    // Close server
    server.close(() => {
      console.log('Server shut down gracefully');
      process.exit(0);
    });

    // Force exit after 5 seconds if server hasn't closed
    setTimeout(() => {
      console.log('Forcing server shutdown after timeout');
      process.exit(1);
    }, 5000);
  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});


const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const { packToFs } = require('ipfs-car/pack/fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = 8020;

// CORS configuration
const corsOptions = {
  origin: '', // Allow frontend origin
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // Cache preflight request results for 24 hours
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Ensure the `assetsfolder` exists
const baseDir = path.join(process.cwd(), 'assetsfolder');
fs.ensureDirSync(baseDir);

// Helper to determine the next folder number
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

// S3 Client setup for AWS Filebase
const s3 = new S3Client({
  endpoint: 'https://s3.filebase.com',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'A48CAC64950102A937C2',
    secretAccessKey: 'd3TAsDywR9xH5eW6TaoYJsgJXbvFutfytPIRzdtD',
  },
});

const bucketName = 'koirengrilso';
let lastRootCID = null; // Variable to store the last Root CID

// Function to create a CAR file and log the root CID
const createCarFile = async (folderPath, outputCarPath) => {
  try {
    const { root } = await packToFs({
      input: folderPath,
      output: outputCarPath,
      wrapWithDirectory: false,
    });

    lastRootCID = root; // Update to the latest Root CID
    console.log(`CAR file created successfully. Root CID: ${root}`);

    return { carFilePath: outputCarPath, rootCID: root };
  } catch (error) {
    console.error('Error creating CAR file:', error.message);
    throw error;
  }
};

// Function to upload the CAR file to S3 and log the upload success
const uploadCarFile = async (carFilePath) => {
  try {
    const fileStream = fs.createReadStream(carFilePath);
    const params = {
      Bucket: bucketName,
      Key: path.basename(carFilePath),
      Body: fileStream,
      Metadata: { import: 'car' },
    };

    const command = new PutObjectCommand(params);
    const response = await s3.send(command);
    console.log(`CAR file uploaded successfully. ETag: ${response.ETag}`);

    // Send only the last root CID to the client
    if (lastRootCID) {
      console.log(`Final Root CID: ${lastRootCID}`);
    }

    return response;
  } catch (error) {
    console.error('Error uploading CAR file:', error.message);
    throw error;
  } finally {
    fs.unlinkSync(carFilePath); // Cleanup: delete the temporary CAR file
  }
};

// Multer configuration for file uploads with a 2GB file size limit
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!req.uploadedFolder) {
      req.uploadedFolder = getNextFolderNumber().toString();
    }
    const folderPath = path.join(baseDir, req.uploadedFolder);
    const subfolder = file.mimetype.startsWith('image/') || file.mimetype === 'video/mp4' ? 'images' : 'metadata';
    const fullPath = path.join(folderPath, subfolder);
    fs.ensureDirSync(fullPath);
    cb(null, fullPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB file size limit
  },
});

// Helper to find the image file extension
const getFileExtension = (fileName, folderPath) => {
  const validExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
  for (const ext of validExtensions) {
    if (fs.existsSync(path.join(folderPath, `${fileName}${ext}`))) {
      return ext;
    }
  }
  return '.png'; // Default to .png if no match
};

// Update metadata files (remove .json extension and update metadata)
const updateMetadataFiles = async (metadataFolderPath, rootCID) => {
  try {
    const files = fs.readdirSync(metadataFolderPath).filter((file) => file.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(metadataFolderPath, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const fileName = path.basename(file, '.json');
      const fileExtension = getFileExtension(fileName, path.join(metadataFolderPath, '..', 'images'));

      // If it's a video, update the metadata with the `video` field instead of `image`
      if (fileExtension === '.mp4') {
        data.video = `ipfs://${rootCID}/${fileName}${fileExtension}`;
      } else {
        data.image = `ipfs://${rootCID}/${fileName}${fileExtension}`;
      }

      // Write the updated metadata without the .json extension
      const newFilePath = path.join(metadataFolderPath, fileName); // Save without .json extension
      fs.writeFileSync(newFilePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`Updated metadata file: ${file}`);

      // Optionally, delete the original .json file after processing
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Error updating metadata files:', error);
    throw error;
  }
};

// POST endpoint to handle file uploads
app.post('/uploadfiles', (req, res) => {
  upload.any()(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File is too large. Maximum size is 2GB' });
      }
      return res.status(500).json({ error: 'Error uploading files.' });
    }

    const folderNumber = req.uploadedFolder;
    const folderPath = path.join(baseDir, folderNumber);

    try {
      const imagesFolderPath = path.join(folderPath, 'images');
      const metadataFolderPath = path.join(folderPath, 'metadata');
      const imagesCarPath = path.join(folderPath, 'images.car');
      const metadataCarPath = path.join(folderPath, 'metadata.car');

      // Create CAR files and upload for images
      const { rootCID: imagesRootCID } = await createCarFile(imagesFolderPath, imagesCarPath);
      await uploadCarFile(imagesCarPath);

      // Update metadata files and create the metadata CAR file
      await updateMetadataFiles(metadataFolderPath, imagesRootCID); // Use the images rootCID for metadata update
      const { rootCID: metadataRootCID } = await createCarFile(metadataFolderPath, metadataCarPath);
      await uploadCarFile(metadataCarPath);

      // Cleanup the folder after processing
      fs.rmdirSync(folderPath, { recursive: true });

      // Send the final rootCID from the metadata CAR file as the last rootCID
      res.status(200).json({
        lastRootCID: String(metadataRootCID), // Explicitly convert to string
      });

    } catch (error) {
      console.error('Error processing files:', error);
      res.status(500).json({ error: 'Error processing files.', logs: error.message });
    }
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

const path = require('path');
const fs = require('fs-extra');
const pLimit = require('p-limit');
const { createCarFile, uploadCarFile } = require('./carUtils');

const baseDir = path.join(process.cwd(), 'assetsfolder');
const limit = pLimit(10);

// Get image/video extension from the folder based on the file name
const getFileExtension = (fileName, folderPath) => {
  const validExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
  for (const ext of validExtensions) {
    if (fs.existsSync(path.join(folderPath, `${fileName}${ext}`))) {
      return ext;
    }
  }
  return '.png'; // Default to .png if no valid extension found
};

// Update metadata files to include the correct image/video IPFS link
const updateMetadataFiles = async (metadataFolderPath, rootCID) => {
  try {
    // Read all JSON files in the metadata folder
    const files = fs.readdirSync(metadataFolderPath).filter((file) => file.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(metadataFolderPath, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const fileName = path.basename(file, '.json');
      const fileExtension = getFileExtension(fileName, path.join(metadataFolderPath, '..', 'images')); // Assuming images are stored in 'images' folder

      // Update the metadata with the correct IPFS link for images/videos
      if (fileExtension === '.mp4') {
        data.video = `ipfs://${rootCID}/${fileName}${fileExtension}`; // Store video link in metadata
      } else {
        data.image = `ipfs://${rootCID}/${fileName}${fileExtension}`; // Store image link in metadata
      }

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`Updated metadata file: ${file}`);
    }
  } catch (error) {
    console.error('Error updating metadata files:', error);
    throw error;
  }
};

// Process each folder (images, metadata) and create CAR files
const processFolder = async (folderName) => {
  const folderPath = path.join(baseDir, folderName, 'images');  // Path to the images folder (images & videos here)
  const outputCarPath = path.join(process.cwd(), `${folderName}-images.car`); // Output path for CAR file of images
  const metadataFolderPath = path.join(baseDir, folderName, 'metadata'); // Path to the metadata folder
  const outputMetadataCarPath = path.join(process.cwd(), `${folderName}-metadata.car`); // Output path for CAR file of metadata

  // Check if images folder exists
  if (!fs.existsSync(folderPath)) {
    console.error(`Directory ${folderPath} does not exist.`);
    return;  // Skip this folder if 'images' folder doesn't exist
  }

  try {
    // Create a CAR file for images/videos and upload it to IPFS
    const { carFilePath, rootCID } = await createCarFile(folderPath, outputCarPath);
    await uploadCarFile(carFilePath);

    // Update metadata with the correct IPFS link for images/videos
    await updateMetadataFiles(metadataFolderPath, rootCID);

    // Create a CAR file for metadata and upload it to IPFS
    const { carFilePath: metadataCarFilePath } = await createCarFile(metadataFolderPath, outputMetadataCarPath);
    await uploadCarFile(metadataCarFilePath);

    // Optionally, remove the folder after processing
    await fs.remove(path.join(baseDir, folderName));
    console.log(`Successfully processed and deleted folder: ${folderName}`);
  } catch (error) {
    console.error(`Error processing folder "${folderName}":`, error);
    throw error;
  }
};

// Process all folders
const processAllFolders = async () => {
  try {
    // Get all folder names in the base directory (assuming they are numeric folder names)
    const folders = fs.readdirSync(baseDir).filter((file) => {
      return fs.statSync(path.join(baseDir, file)).isDirectory() && !isNaN(parseInt(file, 10));  // Ensure folder names are numeric
    });

    // Use concurrency limit to process multiple folders in parallel
    await Promise.all(folders.map((folder) => limit(() => processFolder(folder))));
  } catch (error) {
    console.error('Error processing all folders:', error);
    throw error;
  }
};

// Express handler for POST request to start folder processing
async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      // Call the function to process all folders
      await processAllFolders();
      res.status(200).json({ message: 'Folders processed successfully.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).send(`Method ${req.method} Not Allowed`);
  }
}

module.exports = handler;
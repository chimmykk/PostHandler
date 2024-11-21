const path = require('path');
const fs = require('fs-extra');
const pLimit = require('p-limit');
const { createCarFile, uploadCarFile } = require('./carUtils');

const baseDir = path.join(process.cwd(), 'assetsfolder');
const limit = pLimit(10);

const getImageExtension = (fileName, folderPath) => {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.mp4'];
  for (const ext of imageExtensions) {
    if (fs.existsSync(path.join(folderPath, `${fileName}${ext}`))) {
      return ext;
    }
  }
  return '.png';
};

const updateMetadataFiles = async (metadataFolderPath, rootCID) => {
  try {
    const files = fs.readdirSync(metadataFolderPath).filter((file) => file.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(metadataFolderPath, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const fileName = path.basename(file, '.json');
      const imageExtension = getImageExtension(fileName, path.join(metadataFolderPath, '..', 'images'));

      data.image = `ipfs://${rootCID}/${fileName}${imageExtension}`;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`Updated metadata file: ${file}`);
    }
  } catch (error) {
    console.error('Error updating metadata files:', error);
    throw error;
  }
};

const processFolder = async (folderName) => {
  const folderPath = path.join(baseDir, folderName, 'images');
  const outputCarPath = path.join(process.cwd(), `${folderName}-images.car`);
  const metadataFolderPath = path.join(baseDir, folderName, 'metadata');
  const outputMetadataCarPath = path.join(process.cwd(), `${folderName}-metadata.car`);

  try {
    const { carFilePath, rootCID } = await createCarFile(folderPath, outputCarPath);
    await uploadCarFile(carFilePath);

    await updateMetadataFiles(metadataFolderPath, rootCID);

    const { carFilePath: metadataCarFilePath } = await createCarFile(metadataFolderPath, outputMetadataCarPath);
    await uploadCarFile(metadataCarFilePath);

    await fs.remove(path.join(baseDir, folderName));
    console.log(`Successfully processed and deleted folder: ${folderName}`);
  } catch (error) {
    console.error(`Error processing folder "${folderName}":`, error);
    throw error;
  }
};

const processAllFolders = async () => {
  try {
    const folders = fs.readdirSync(baseDir).filter((file) => {
      return fs.statSync(path.join(baseDir, file)).isDirectory() && !isNaN(parseInt(file, 10));
    });

    await Promise.all(folders.map((folder) => limit(() => processFolder(folder))));
  } catch (error) {
    console.error('Error processing all folders:', error);
    throw error;
  }
};

async function handler(req, res) {
  if (req.method === 'POST') {
    try {
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
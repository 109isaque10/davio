import {createHash} from 'crypto';
import { createClient } from "webdav/web";
import Fuse from 'fuse.js'
import {parseWords, numberPad, bytesToSize, isVideo, wait, isSubtitle} from './util.js';
import config from './config.js';
import cache from './cache.js';
import * as meta from './meta.js';

const actionInProgress = {
  getFiles: {}
};

var subtitles = []

function parseStremioId(stremioId){
  const [id, season, episode] = stremioId.split(':');
  return {id, season: parseInt(season || 0), episode: parseInt(episode || 0)};
}

async function hash(str){
  return createHash('md5').update(str).digest('hex')
}

async function getMetaInfos(type, stremioId){
  const {id, season, episode} = parseStremioId(stremioId);
  if(type == 'movie'){
    return meta.getMovieById(id);
  }else if(type == 'series'){
    return meta.getEpisodeById(id, season, episode);
  }else{
    throw new Error(`Unsuported type ${type}`);
  }
}

async function mergeDefaultUserConfig(userConfig){
  // config.immulatableUserConfigKeys.forEach(key => delete userConfig[key]);
  config.id = await hash(`${userConfig.url}${userConfig.username}${userConfig.password}`);
  return Object.assign({}, config.defaultUserConfig, userConfig);
}

function isEpisodeFile(file, episode){
  return file.basename.includes(`${numberPad(episode)}`);
}

function isEpisodeSeasonFile(file, season, episode){
  return file.basename.includes(`S${numberPad(season)}E${numberPad(episode)}`);
}

function isSimpleEpisodeSeasonFile(file, season, episode){
  return file.basename.includes(`${season}${numberPad(episode)}`);
}

async function getFilesRecursive(client, path){
  let files = [];
  try {
    const contents = await client.getDirectoryContents(path);
    for(const item of contents){
      files.push(item)
    }
  }catch(err){
    console.log('getFilesRecursive', err);
  }
  return files;
}

async function getFiles(client, userConfig, type, name, season){

  const cacheKey = `davfiles:${userConfig.id}:${type}:${name}:${season}`;

  while(actionInProgress.getFiles[cacheKey]){
    await wait(100);
  }
  actionInProgress.getFiles[cacheKey] = true;

  try {

    let files = await cache.get(cacheKey);

    if(!files){
      let root = '/'
      if(type == 'series'){
        root = userConfig.rootTV
      }else{
        root = userConfig.root
      }
      files = await getFilesRecursive(client, root);
      files = files.filter(file => file.basename.includes(name));
      files = await getFilesRecursive(client, files[0].filename);
      files = files.filter(file => file.basename.includes(`Season ${numberPad(season)}`), file => file.basename.includes(`Season ${numberPad(season, 2)}`));
      files = await getFilesRecursive(client, files[0].filename);
      console.log(file.basename);
      subtitles = files.filter(file => isSubtitle(file.basename));
      console.log(subtitles);
      files = files.filter(file => isVideo(file.basename));
      await cache.set(cacheKey, files, {ttl: 259200});
    }

    return files || [];

  }finally{
    delete actionInProgress.getFiles[cacheKey];
  }

}

export async function getStreams(userConfig, type, stremioId, publicUrl){

  userConfig = await mergeDefaultUserConfig(userConfig);
  const {id, season, episode} = parseStremioId(stremioId);

  const client = createClient(userConfig.url, {
    username: userConfig.username,
    password: userConfig.password
  });

  let metaInfos = await getMetaInfos(type, stremioId);

  let files = [];
  let startDate = new Date();

  console.log(`${stremioId} : ${userConfig.shortName} : Searching files ...`);

  files = await getFiles(client, userConfig, type, metaInfos.name, season);

  console.log(`${stremioId} : ${userConfig.shortName} : ${files.length} total files fetched from (${new URL(userConfig.url).hostname}) in ${(new Date() - startDate) / 1000}s`);
  startDate = new Date();

  const fuse = new Fuse(files, {keys: ['filename', 'basename'], threshold: 0.3});
  files = type == 'series' ? fuse.search(metaInfos.name) : fuse.search(`${metaInfos.name} ${metaInfos.year}`);
  files = files.map(file => file.item);

  if(type == 'series'){
    files = files.filter(file => isEpisodeSeasonFile(file, season, episode));
  } else if(!files){
    files = files.filter(file => isSimpleEpisodeSeasonFile(file, season, episode));
  } else{
    files = files.filter(file => isEpisodeFile(file, episode));
  }

  console.log(`${stremioId} : ${userConfig.shortName}: ${files.length} files found in ${(new Date() - startDate) / 1000}s`);

  files.forEach(file => {
    const basename = file.basename.toLowerCase();
    file.quality = config.qualities.find(q => q.value != 0 && basename.includes(`${q.value}p`)) || config.qualities[0];
    file.languages = config.languages.filter(l => parseWords(basename).join(' ').match(l.pattern));
    file.subtitles = []
    for (let index = 0; index < subtitles.length; index++) {
      if((subtitle.basename.split('.').at(-1)).includes(file.basename)){
        file.subtitles.push(subtitle);
        console.log(subtitle);
      }
      subtitles.splice(index, 1);
    };
    console.log(file.subtitles);
    for (let index = 0; index < file.subtitles.length; index++) {
      const element = file.subtitles[index];
      element = {
        id: index,
        url: client.getFileDownloadLink(element.filename),
        language: 'en'
      };
      file.subtitles[index] = element;
    }
    console.log(file.subtitles);
  });

  files = files.sort((a, b) => b.quality.value - a.quality.value);

  return files.map(file => {
    const rows = [file.basename];
    const details = [`💾${bytesToSize(file.size)}`, ...file.languages.map(language => language.emoji)];
    rows.push(details.join(' '));
    const stream = {
      name: `[${userConfig.shortName}+] ${config.addonName} ${file.quality.label || ''}`,
      description: rows.join("\n"),
      url: client.getFileDownloadLink(file.filename),
      subtitles: file.subtitles,
      notWebReady: 'true',
      behaviorHints: {
        bingeGroup: 'davio|'+file.basename,
        filename: file.basename
      }
    }
    console.log(`${stremioId} : ${userConfig.shortName}: stream found: \n${JSON.stringify(stream)}`)
    return stream;
  });

}

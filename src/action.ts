import * as yaml from "js-yaml";
import {DefineLabelMatches} from "./labels";
import {LabelAndCriteria} from "./labels";
import { Toolkit } from 'actions-toolkit';

Toolkit.run( async tools => {
	//#region Main code
	const configPath              = tools.inputs.config;
	const PRLabelCheck 	      = !!tools.inputs.pr_label_check;
	const pr_No :number|undefined = tools.context.payload.pull_request?.number;
    	const useDefaultLabels        = configPath ===  "N/A";

	if (!configPath) {
		tools.exit.failure(`Config parameter is undefined`);
		return;
	}
	if (!pr_No) {
		tools.exit.failure(`Did not provide pr number`);
		return;
	}

	tools.log("PR number is: " + pr_No);
	const labels               = await GetLabels(configPath, useDefaultLabels);
	const outputLabels         = LabelsToOutput(labels);
	const pr_Title             = (await GetPRData(pr_No)).title;
	var   labelsToAdd          = MatchLabelsWithTitle(pr_Title, labels);
	tools.outputs.Labels 	   = outputLabels;

	if (labelsToAdd.length > 0) {
		//Is the label on the pull request already?
		labelsToAdd = await LabelExistOnPullRequest(pr_No, labelsToAdd);

		if (labelsToAdd.length > 0) {
			await AddLabel(pr_No, labelsToAdd);
		}
		else {
			//Label already exists on PR
			tools.log("No new labels added to PR");
		}
	}
	else {
		// no label criteria matched with PR Title
		tools.log("No labels to add to PR");
	}

	if (PRLabelCheck)
	{
		tools.log(`Checking PR to ensure only one label of config labels below has been added.\n ${outputLabels}`)
		ValidatePRLabel(pr_No,labelsToAdd, outputLabels)
	}
	tools.exit.success("Action complete");

	//#endregion

	//#region Github calls

	/*
	* Check PR labels to ensure only one of the config labels has been added to it
	*/
	async function ValidatePRLabel(pr_No :number , labelAdded :string[], outputLabels :string) {

		const pr_Labels  = (await GetPRData(pr_No)).labels;
		const configLabels : string[] = outputLabels.split(',').map((i) => i.trim());
		var configLabelMatch = false;

		if (pr_Labels.length<1)
		{
			tools.exit.failure("PR has no labels");
		}

		for (let label of pr_Labels) {

			let name = typeof(label) ===  "string" ? label: label.name;
			if (!name) {continue;}

			tools.log(`Check pr label ${name} matches what we added ${labelAdded[0]}`);

			//Match PR labels with the config labels
			if (Arr_Match(configLabels, name)) {
				configLabelMatch = true;
				if (labelAdded[0] != name)
				{
					tools.exit.failure(`Only one label should be added from the config labels list.
					\n Expected ${labelAdded}\n Actual: ${name}.`);
					return;
				}
			}
		}

		if (configLabelMatch == false)
		{
			tools.exit.failure("No labels from config added to PR");
		}
	}

	/* Remove labels from labelsToAdd if they exist on pull request
	*  Return: labelsToAdd
	*/
	async function LabelExistOnPullRequest(pr_No :number , labelsToAdd :string[]) {

		const pr_Labels  = (await GetPRData(pr_No)).labels

		if (pr_Labels.length > 0) {
			tools.log("This PR has labels, checking...");

			for (let label of pr_Labels) {

				let name = typeof(label) ===  "string" ? label: label.name;
				if (!name) {continue;}

				if (Arr_Match(labelsToAdd, name)) {
					tools.log(`Label ${name} already added to PR`);
					RemoveFromArray(labelsToAdd, name);
				}
			}
		}

		return labelsToAdd;
	}

	/* Add labels to pull request.
	*/
	async function AddLabel(prNumber :number, labelsToAdd :string[]) {

		tools.log(`Label to add to PR: ${labelsToAdd}`)

		await tools.github.issues.addLabels({
			owner: tools.context.repo.owner,
			repo: tools.context.repo.repo,
			issue_number: prNumber,
			labels: labelsToAdd
		});
		tools.log("Labels added");
	}

	/* Get the PR Title from PR number
	* Return pull request data property
	*/
	async function GetPRData(pr_No : number) {

		const pullRequest = await tools.github.issues.get({
			owner: tools.context.repo.owner,
			repo: tools.context.repo.repo,
			issue_number: pr_No,
		});
		tools.log("Get pull request data");
		return pullRequest.data;
	}

	/* Request content from github repo from the path
	*  containing yml config file
	*  Return the octokit response
	*/
	async function GetConfigContent(path :string) {

		var response = await tools.github.repos.getContent({
			owner: tools.context.repo.owner,
			repo: tools.context.repo.repo,
			path: path,
			ref: tools.context.sha,
		});

		return response;
	}
	//#endregion

	//#region Data manipulation

	/* Get the labels and their matching criteria from a file
	*  or function.
	*  Return Labels and matching criteria as LabelAndCriteria[]
	*/
	async function GetLabels(configPath :string, useDefaultLabels :boolean) {

		var labels :LabelAndCriteria[] = [];

		if (useDefaultLabels) {
			tools.log(`Get label defaults`);
			labels = DefineLabelMatches();
		}
		else {
			tools.log(`Get label config file: ${configPath}`);
			let configContent : any      = await GetConfigContent(configPath);
			let encodedFileContent : any = Buffer.from(configContent.data.content, configContent.data.encoding);
			let yamlFileContent          = yaml.load(encodedFileContent);
			labels	                     = GetLabelsFromFile(yamlFileContent);
		}

		return labels;
	}

	/* Match the first word in pr_Title with the label's matching
	*  criteria.
	*  Return string[] of matched labels, otherwise empty
	* Remarks - Return is currently limited to first match
	*/
	function MatchLabelsWithTitle(pr_Title :string, labels :LabelAndCriteria[]) {

		var matchedLabels : string[] = [];

		tools.log(`Matching label criteria with PR title: ${pr_Title}`);
		for (let labelData of labels)
		{
			for (let criterion of labelData.criteria){
				if (Str_Match(pr_Title,criterion)) {
					tools.log(`Matched... Add Label: [${labelData.name}] to pull request`);
					matchedLabels.push(labelData.name);
					return matchedLabels;
				}
			}
		}

		//only reach here if no label is matched
		return matchedLabels;
	}

	/* Remove strMatch from arr if it exists
	*/
	function RemoveFromArray(arr :string[], strMatch :String) {

		var lowercaseArr = arr.map(function(value){
			return value.toLowerCase();
		});

		const index = lowercaseArr.indexOf(strMatch.toLowerCase());

		if (index > -1) {
			arr.splice(index, 1);
		}
	}

	/* Given string strBase does it start with strMatch
	*  returns: True|False
	*/
	function Str_Match(strBase :string, strMatch :string) {

		if (strBase.toLowerCase().startsWith(strMatch.toLowerCase())) {
			return true;
		}
		else { return false; }
	}

	/* Given array arrBase for each item, does it start with strMatch
	*  returns: True|False
	*/
	function Arr_Match(arrBase :string[], strMatch :string) {

		for (let item of arrBase) {
			if (Str_Match(item,strMatch)) {
				return true;
			}
		}
		return false;
	}

	/* Define the labels to output
	*  Return string of labels
	*/
	function LabelsToOutput(labelAndMatchCriteria :LabelAndCriteria []) {

		const outputLabels = [];

		for (const labelData of labelAndMatchCriteria) {
			outputLabels.push(labelData.name);
		}
		return outputLabels.join(',');
	}

	/* Get labels and their matching criteria
	*  from yamlFileContent: [object Object]
	*  return the array of labels and their matching criteria
	*  E.g. Array of [[label1,'matchA','matchB'],['label2','matchC'],...]
	*  Return Labels and matching criteria as LabelAndCriteria[]
	*/
	function GetLabelsFromFile(yamlFileContent:any) {

		var labels : LabelAndCriteria[] = [];

		for (const tag in yamlFileContent) {
			if (typeof yamlFileContent[tag] === "string") {
				labels.push({name:tag, criteria:yamlFileContent[tag]});
			} else if (Array.isArray([yamlFileContent[tag]])) {
				let labelCriteria :any[] = yamlFileContent[tag].toString().split(',');
				labels.push({name: tag, criteria: labelCriteria})
			} else {
				tools.log(`Unknown value type for label ${tag}. Expecting string or array)`);
			}
		}
		return labels;
	}
	//#endregion
});

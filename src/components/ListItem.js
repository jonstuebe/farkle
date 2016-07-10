import React from 'react';

const ListItem = React.createClass({
	getDefaultProps() {
		return {
			onClick: null,
			roll: false,
		};
	},
	render(){

		let listItemActive = ['list-item'];
		if(this.props.active) listItemActive.push('list-item--active');

		let attrs = {};
		if(this.props.onClick) {
			attrs.onClick = this.props.onClick;
		}

		return (


			<div className={listItemActive.join(' ')} {...attrs}>
				<div className="list-item__info">
					<h3 className="list-item__title">{this.props.title}</h3>
					<p className="list-item__details">{this.props.details}</p>
				</div>
			</div>
		)
	}
});

export default ListItem;
